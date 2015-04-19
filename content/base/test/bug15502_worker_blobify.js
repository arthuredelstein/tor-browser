// Wait for a string to be posted to this worker.
// Create a blob containing this string, and then
// post back a blob URL pointing to the blob.
self.addEventListener("message", function (e) {
  var blob = new Blob([e.data]),
      blobURL = URL.createObjectURL(blob);
  postMessage(blobURL);
}, false);
