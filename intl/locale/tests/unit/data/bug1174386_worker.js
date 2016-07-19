self.onmessage = function (data) {
  if (Intl) {
    let myLocale = Intl.NumberFormat().resolvedOptions().locale;
    self.postMessage(myLocale);
  } else {
    self.postMessage("Intl unavailable");
  }
};

