// # task_spawn.js
// A simple implementation of Task.spawn. For detailed usage instructions,
// see https://developer.mozilla.org/en-US/docs/Mozilla/JavaScript_code_modules/Task.jsm

/* jshint esnext: true */

// __spawn(generatorFunction)__.
// Expose only the spawn function, very similar to Task.spawn in Task.jsm.
let spawn = (function () {

// Declare ahead
let promiseFromGenerator;

// Returns true if aValue is a generator object.
let isGenerator = aValue => {
  return Object.prototype.toString.call(aValue) === "[object Generator]";
};

// Converts the right-hand argument of yield or return values to a Promise,
// according to Task.jsm semantics.
let asPromise = yieldArgument => {
  if (yieldArgument instanceof Promise) {
    return yieldArgument;
  } else if (isGenerator(yieldArgument)) {
    return promiseFromGenerator(yieldArgument);
  } else if (yieldArgument instanceof Function) {
    return asPromise(yieldArgument());
  } else if (yieldArgument instanceof Error) {
    return Promise.reject(yieldArgument);
  } else {
    return Promise.resolve(yieldArgument);
  }
};

// Takes a generator object and runs it as an asynchronous task,
// returning a Promise with the result of that task.
promiseFromGenerator = generator => {
  return new Promise((resolve, reject) => {
    let processPromise;
    let processPromiseResult = (success, result) => {
      try {
        let {value, done} = success ? generator.next(result)
                                    : generator.throw(result);
        if (done) {
          asPromise(value).then(resolve, reject);
        } else {
          processPromise(asPromise(value));
        }
      } catch (error) {
        reject(error);
      }
    };
    processPromise = promise => {
      promise.then(result => processPromiseResult(true, result),
                   error => processPromiseResult(false, error));
    };
    processPromise(asPromise(undefined));
  });
};

// __spawn(generatorFunction)__.
return generatorFunction => promiseFromGenerator(generatorFunction());
})();
