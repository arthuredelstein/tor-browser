// Wait for a mediasource URL to be posted to this worker.
// Attempt to obtain the media source and post "retrieved" if
// successful.

var postStringInBlob = function (blobObject) {
  var fileReader = new FileReaderSync(),
      result = fileReader.readAsText(blobObject);
  postMessage(result);
};

self.addEventListener("message", function (e) {
  var mediaSourceURL = e.data,
      xhr = new XMLHttpRequest();
  try {
    xhr.open("GET", mediaSourceURL, true);
    xhr.onload = function () {
      postMessage("retrieved");
    };
    xhr.responseType = "mediasource";
    xhr.send();
  } catch (e) {
    postMessage(e.message);
  }
}, false);
