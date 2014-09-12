/* -*- Mode: C++; tab-width: 2; indent-tabs-mode: nil; c-basic-offset: 2 -*- */
/* vim:set ts=2 sw=2 sts=2 et cindent: */
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/. */

#include <CoreFoundation/CFString.h>

#include "AppleCMLinker.h"
#include "AppleUtils.h"
#include "AppleVTDecoder.h"
#include "AppleVTLinker.h"
#include "mp4_demuxer/DecoderData.h"
#include "MP4Reader.h"
#include "MP4Decoder.h"
#include "MediaData.h"
#include "MacIOSurfaceImage.h"
#include "mozilla/ArrayUtils.h"
#include "nsAutoPtr.h"
#include "nsThreadUtils.h"
#include "prlog.h"
#include "VideoUtils.h"

#ifdef PR_LOGGING
PRLogModuleInfo* GetAppleMediaLog();
#define LOG(...) PR_LOG(GetAppleMediaLog(), PR_LOG_DEBUG, (__VA_ARGS__))
//#define LOG_MEDIA_SHA1
#else
#define LOG(...)
#endif

#ifdef LOG_MEDIA_SHA1
#include "mozilla/SHA1.h"
#endif

namespace mozilla {

AppleVTDecoder::AppleVTDecoder(const mp4_demuxer::VideoDecoderConfig& aConfig,
                               MediaTaskQueue* aVideoTaskQueue,
                               MediaDataDecoderCallback* aCallback,
                               layers::ImageContainer* aImageContainer)
  : mConfig(aConfig)
  , mTaskQueue(aVideoTaskQueue)
  , mCallback(aCallback)
  , mImageContainer(aImageContainer)
  , mFormat(nullptr)
  , mSession(nullptr)
{
  MOZ_COUNT_CTOR(AppleVTDecoder);
  // TODO: Verify aConfig.mime_type.
  LOG("Creating AppleVTDecoder for %dx%d h.264 video",
      mConfig.display_width,
      mConfig.display_height
     );
}

AppleVTDecoder::~AppleVTDecoder()
{
  MOZ_COUNT_DTOR(AppleVTDecoder);
}

nsresult
AppleVTDecoder::Init()
{
  nsresult rv = InitializeSession();
  return rv;
}

nsresult
AppleVTDecoder::Shutdown()
{
  if (mSession) {
    LOG("%s: cleaning up session %p", __func__, mSession);
    VTDecompressionSessionInvalidate(mSession);
    CFRelease(mSession);
    mSession = nullptr;
  }
  if (mFormat) {
    LOG("%s: releasing format %p", __func__, mFormat);
    CFRelease(mFormat);
    mFormat = nullptr;
  }
  return NS_OK;
}

nsresult
AppleVTDecoder::Input(mp4_demuxer::MP4Sample* aSample)
{
  LOG("mp4 input sample %p pts %lld duration %lld us%s %d bytes",
      aSample,
      aSample->composition_timestamp,
      aSample->duration,
      aSample->is_sync_point ? " keyframe" : "",
      aSample->size);

#ifdef LOG_MEDIA_SHA1
  SHA1Sum hash;
  hash.update(aSample->data, aSample->size);
  uint8_t digest_buf[SHA1Sum::kHashSize];
  hash.finish(digest_buf);
  nsAutoCString digest;
  for (size_t i = 0; i < sizeof(digest_buf); i++) {
    digest.AppendPrintf("%02x", digest_buf[i]);
  }
  LOG("    sha1 %s", digest.get());
#endif // LOG_MEDIA_SHA1

  mTaskQueue->Dispatch(
      NS_NewRunnableMethodWithArg<nsAutoPtr<mp4_demuxer::MP4Sample>>(
          this,
          &AppleVTDecoder::SubmitFrame,
          nsAutoPtr<mp4_demuxer::MP4Sample>(aSample)));
  return NS_OK;
}

nsresult
AppleVTDecoder::Flush()
{
  mTaskQueue->Flush();
  nsresult rv = WaitForAsynchronousFrames();
  if (NS_FAILED(rv)) {
    LOG("AppleVTDecoder::Drain failed waiting for platform decoder.");
  }
  ClearReorderedFrames();

  return rv;
}

nsresult
AppleVTDecoder::Drain()
{
  mTaskQueue->AwaitIdle();
  nsresult rv = WaitForAsynchronousFrames();
  if (NS_FAILED(rv)) {
    LOG("AppleVTDecoder::Drain failed waiting for platform decoder.");
    return rv;
  }
  DrainReorderedFrames();
  mCallback->DrainComplete();
  return NS_OK;
}

//
// Implementation details.
//

// Context object to hold a copy of sample metadata.
class FrameRef {
public:
  Microseconds decode_timestamp;
  Microseconds composition_timestamp;
  Microseconds duration;
  int64_t byte_offset;
  bool is_sync_point;

  explicit FrameRef(mp4_demuxer::MP4Sample* aSample)
  {
    MOZ_ASSERT(aSample);
    decode_timestamp = aSample->decode_timestamp;
    composition_timestamp = aSample->composition_timestamp;
    duration = aSample->duration;
    byte_offset = aSample->byte_offset;
    is_sync_point = aSample->is_sync_point;
  }
};

// Callback passed to the VideoToolbox decoder for returning data.
// This needs to be static because the API takes a C-style pair of
// function and userdata pointers. This validates parameters and
// forwards the decoded image back to an object method.
static void
PlatformCallback(void* decompressionOutputRefCon,
                 void* sourceFrameRefCon,
                 OSStatus status,
                 VTDecodeInfoFlags flags,
                 CVImageBufferRef image,
                 CMTime presentationTimeStamp,
                 CMTime presentationDuration)
{
  LOG("AppleVideoDecoder %s status %d flags %d", __func__, status, flags);

  AppleVTDecoder* decoder =
    static_cast<AppleVTDecoder*>(decompressionOutputRefCon);
  nsAutoPtr<FrameRef> frameRef =
    nsAutoPtr<FrameRef>(static_cast<FrameRef*>(sourceFrameRefCon));

  LOG("mp4 output frame %lld dts %lld pts %lld duration %lld us%s",
    frameRef->byte_offset,
    frameRef->decode_timestamp,
    frameRef->composition_timestamp,
    frameRef->duration,
    frameRef->is_sync_point ? " keyframe" : ""
  );

  // Validate our arguments.
  if (status != noErr || !image) {
    NS_WARNING("VideoToolbox decoder returned no data");
    return;
  }
  if (flags & kVTDecodeInfo_FrameDropped) {
    NS_WARNING("  ...frame dropped...");
  }
  MOZ_ASSERT(CFGetTypeID(image) == CVPixelBufferGetTypeID(),
    "VideoToolbox returned an unexpected image type");

  // Forward the data back to an object method which can access
  // the correct MP4Reader callback.
  decoder->OutputFrame(image, frameRef);
}

nsresult
AppleVTDecoder::WaitForAsynchronousFrames()
{
  OSStatus rv = VTDecompressionSessionWaitForAsynchronousFrames(mSession);
  if (rv != noErr) {
    LOG("AppleVTDecoder: Error %d waiting for asynchronous frames", rv);
    return NS_ERROR_FAILURE;
  }
  return NS_OK;
}

void
AppleVTDecoder::DrainReorderedFrames()
{
  while (!mReorderQueue.IsEmpty()) {
    mCallback->Output(mReorderQueue.Pop());
  }
}

void
AppleVTDecoder::ClearReorderedFrames()
{
  while (!mReorderQueue.IsEmpty()) {
    delete mReorderQueue.Pop();
  }
}

// Copy and return a decoded frame.
nsresult
AppleVTDecoder::OutputFrame(CVPixelBufferRef aImage,
                            nsAutoPtr<FrameRef> aFrameRef)
{
  IOSurfacePtr surface = MacIOSurfaceLib::CVPixelBufferGetIOSurface(aImage);
  MOZ_ASSERT(surface, "VideoToolbox didn't return an IOSurface backed buffer");

  nsRefPtr<MacIOSurface> macSurface = new MacIOSurface(surface);
  // Bounds.
  VideoInfo info;
  info.mDisplay = nsIntSize(macSurface->GetWidth(), macSurface->GetHeight());
  info.mHasVideo = true;
  gfx::IntRect visible = gfx::IntRect(0,
                                      0,
                                      mConfig.display_width,
                                      mConfig.display_height);

  nsRefPtr<layers::Image> image =
    mImageContainer->CreateImage(ImageFormat::MAC_IOSURFACE);
  layers::MacIOSurfaceImage* videoImage =
    static_cast<layers::MacIOSurfaceImage*>(image.get());
  videoImage->SetSurface(macSurface);

  nsAutoPtr<VideoData> data;
  data = VideoData::CreateFromImage(info,
                                    mImageContainer,
                                    aFrameRef->byte_offset,
                                    aFrameRef->composition_timestamp,
                                    aFrameRef->duration, image.forget(),
                                    aFrameRef->is_sync_point,
                                    aFrameRef->decode_timestamp,
                                    visible);

  if (!data) {
    NS_ERROR("Couldn't create VideoData for frame");
    mCallback->Error();
    return NS_ERROR_FAILURE;
  }

  // Frames come out in DTS order but we need to output them
  // in composition order.
  mReorderQueue.Push(data.forget());
  // Assume a frame with a PTS <= current DTS is ready.
  while (mReorderQueue.Length() > 0) {
    VideoData* readyData = mReorderQueue.Pop();
    if (readyData->mTime <= aFrameRef->decode_timestamp) {
      LOG("returning queued frame with pts %lld", readyData->mTime);
      mCallback->Output(readyData);
    } else {
      LOG("requeued frame with pts %lld > %lld",
          readyData->mTime, aFrameRef->decode_timestamp);
      mReorderQueue.Push(readyData);
      break;
    }
  }
  LOG("%llu decoded frames queued",
      static_cast<unsigned long long>(mReorderQueue.Length()));

  return NS_OK;
}

// Helper to fill in a timestamp structure.
static CMSampleTimingInfo
TimingInfoFromSample(mp4_demuxer::MP4Sample* aSample)
{
  CMSampleTimingInfo timestamp;

  timestamp.duration = CMTimeMake(aSample->duration, USECS_PER_S);
  timestamp.presentationTimeStamp =
    CMTimeMake(aSample->composition_timestamp, USECS_PER_S);
  timestamp.decodeTimeStamp =
    CMTimeMake(aSample->decode_timestamp, USECS_PER_S);

  return timestamp;
}

nsresult
AppleVTDecoder::SubmitFrame(mp4_demuxer::MP4Sample* aSample)
{
  // For some reason this gives me a double-free error with stagefright.
  AutoCFRelease<CMBlockBufferRef> block = nullptr;
  AutoCFRelease<CMSampleBufferRef> sample = nullptr;
  VTDecodeInfoFlags flags;
  OSStatus rv;

  // FIXME: This copies the sample data. I think we can provide
  // a custom block source which reuses the aSample buffer.
  // But note that there may be a problem keeping the samples
  // alive over multiple frames.
  rv = CMBlockBufferCreateWithMemoryBlock(NULL // Struct allocator.
                                         ,aSample->data
                                         ,aSample->size
                                         ,kCFAllocatorNull // Block allocator.
                                         ,NULL // Block source.
                                         ,0    // Data offset.
                                         ,aSample->size
                                         ,false
                                         ,block.receive());
  NS_ASSERTION(rv == noErr, "Couldn't create CMBlockBuffer");
  CMSampleTimingInfo timestamp = TimingInfoFromSample(aSample);
  rv = CMSampleBufferCreate(NULL, block, true, 0, 0, mFormat, 1, 1, &timestamp, 0, NULL, sample.receive());
  NS_ASSERTION(rv == noErr, "Couldn't create CMSampleBuffer");
  rv = VTDecompressionSessionDecodeFrame(mSession,
                                         sample,
                                         0,
                                         new FrameRef(aSample),
                                         &flags);
  NS_ASSERTION(rv == noErr, "Couldn't pass frame to decoder");

  // Ask for more data.
  if (mTaskQueue->IsEmpty()) {
    LOG("AppleVTDecoder task queue empty; requesting more data");
    mCallback->InputExhausted();
  }

  return NS_OK;
}

nsresult
AppleVTDecoder::InitializeSession()
{
  OSStatus rv;
  AutoCFRelease<CFMutableDictionaryRef> extensions =
    CFDictionaryCreateMutable(NULL, 0,
                              &kCFTypeDictionaryKeyCallBacks,
                              &kCFTypeDictionaryValueCallBacks);
  AppleUtils::SetCFDict(extensions, "CVImageBufferChromaLocationBottomField", "left");
  AppleUtils::SetCFDict(extensions, "CVImageBufferChromaLocationTopField", "left");
  AppleUtils::SetCFDict(extensions, "FullRangeVideo", true);

  AutoCFRelease<CFMutableDictionaryRef> atoms =
    CFDictionaryCreateMutable(NULL, 0,
                              &kCFTypeDictionaryKeyCallBacks,
                              &kCFTypeDictionaryValueCallBacks);
  AutoCFRelease<CFDataRef> avc_data = CFDataCreate(NULL,
      mConfig.extra_data.begin(), mConfig.extra_data.length());

#ifdef LOG_MEDIA_SHA1
  SHA1Sum avc_hash;
  avc_hash.update(mConfig.extra_data.begin(), mConfig.extra_data.length());
  uint8_t digest_buf[SHA1Sum::kHashSize];
  avc_hash.finish(digest_buf);
  nsAutoCString avc_digest;
  for (size_t i = 0; i < sizeof(digest_buf); i++) {
    avc_digest.AppendPrintf("%02x", digest_buf[i]);
  }
  LOG("AVCDecoderConfig %ld bytes sha1 %s",
      mConfig.extra_data.length(), avc_digest.get());
#endif // LOG_MEDIA_SHA1

  CFDictionarySetValue(atoms, CFSTR("avcC"), avc_data);
  CFDictionarySetValue(extensions, CFSTR("SampleDescriptionExtensionAtoms"), atoms);
  rv = CMVideoFormatDescriptionCreate(NULL, // Use default allocator.
                                      kCMVideoCodecType_H264,
                                      mConfig.display_width,
                                      mConfig.display_height,
                                      extensions,
                                      &mFormat);
  if (rv != noErr) {
    NS_ERROR("Couldn't create format description!");
    return NS_ERROR_FAILURE;
  }

  // Contruct video decoder selection spec.
  AutoCFRelease<CFDictionaryRef> spec = CreateDecoderSpecification();

  // Contruct output configuration.
  AutoCFRelease<CFDictionaryRef> IOSurfaceProperties =
    CFDictionaryCreate(NULL,
                       NULL,
                       NULL,
                       0,
                       &kCFTypeDictionaryKeyCallBacks,
                       &kCFTypeDictionaryValueCallBacks);

  SInt32 PixelFormatTypeValue = kCVPixelFormatType_32BGRA;
  AutoCFRelease<CFNumberRef> PixelFormatTypeNumber =
    CFNumberCreate(NULL, kCFNumberSInt32Type, &PixelFormatTypeValue);

  const void* outputKeys[] = { kCVPixelBufferIOSurfacePropertiesKey,
                               kCVPixelBufferPixelFormatTypeKey,
                               kCVPixelBufferOpenGLCompatibilityKey };
  const void* outputValues[] = { IOSurfaceProperties,
                                 PixelFormatTypeNumber,
                                 kCFBooleanTrue };
  AutoCFRelease<CFDictionaryRef> outputConfiguration =
    CFDictionaryCreate(NULL,
                       outputKeys,
                       outputValues,
                       ArrayLength(outputKeys),
                       &kCFTypeDictionaryKeyCallBacks,
                       &kCFTypeDictionaryValueCallBacks);

  VTDecompressionOutputCallbackRecord cb = { PlatformCallback, this };
  rv = VTDecompressionSessionCreate(NULL, // Allocator.
                                    mFormat,
                                    spec, // Video decoder selection.
                                    outputConfiguration, // Output video format.
                                    &cb,
                                    &mSession);

  if (rv != noErr) {
    NS_ERROR("Couldn't create decompression session!");
    return NS_ERROR_FAILURE;
  }

  return NS_OK;
}

CFDictionaryRef
AppleVTDecoder::CreateDecoderSpecification()
{
  if (!AppleVTLinker::GetPropHWAccel()) {
    return nullptr;
  }

  const void* specKeys[] = { AppleVTLinker::GetPropHWAccel() };
  const void* specValues[] = { kCFBooleanTrue };
  return CFDictionaryCreate(NULL,
                            specKeys,
                            specValues,
                            ArrayLength(specKeys),
                            &kCFTypeDictionaryKeyCallBacks,
                            &kCFTypeDictionaryValueCallBacks);
}

} // namespace mozilla
