# flux-native

## Features
1. Easy to use and simple APIs, no reducer, no provider, no action type, no 3rd lib needed for async dispatching
1. Support advance action handling: cancel, suspend, resume
1. Support action transaction
1. Support state merging
1. Support multiple action dispatching ways: once, on component mount, on component unmount

## Counter App

```jsx harmony
import React from "react";
import { render } from "react-dom";
import { dispatch, useStore } from "flux-native";

const Initial = () => ({ count: 1 });

dispatch(Initial);

const Increase = state => ({ ...state, count: state.count + 1 });

const App = () => {
  const [count] = useStore(state => state.count);
  const handleIncrease = () => dispatch(Increase);
  return (
    <>
      <h1>{count}</h1>
      <button onClick={handleIncrease}>Increase</button>
    </>
  );
};

render(<App />, document.getElementById("root"));
```

## Search App

```jsx harmony
import React from "react";
import { render } from "react-dom";
import { dispatch, useStore } from "flux-native";

const Initial = () => ({ keyword: "", results: [] });

dispatch(Initial);

const Fetch3Items = state => ({
  ...state,
  results: ["result 1", "result 2", "result 3"]
});

const NotFound = state => ({ ...state, results: [] });

// save keyword to sate
const UpdateKeyword = (state, keyword) => ({ ...state, keyword });

const FetchSearchResults = state => ({ dispatch, check }) => {
  // enable state checking before dispatching
  check((current, prev) => {
    // perform dispatching if keyword does not change
    return current.keyword === prev.keyword;
  });

  if (state.keyword === "abc") {
    setTimeout(dispatch, 1000, Fetch3Items);
  } else {
    dispatch(NotFound);
  }
};

const Search = (state, keyword) => ({ dispatch }) => {
  dispatch(UpdateKeyword, keyword);
  dispatch(FetchSearchResults);
};

const App = () => {
  const [results] = useStore(state => state.results);
  const handleSearch = e => dispatch(Search, e.target.value);
  return (
    <>
      <input
        type="text"
        onChange={handleSearch}
        placeholder="Enter search term (ex: abc)"
      />
      <ul>
        {results.map(result => (
          <li key={result}>{result}</li>
        ))}
      </ul>
    </>
  );
};

render(<App />, document.getElementById("root"));
```

## Monitoring and handling action dispatching status

```jsx harmony
import React, { useRef, useState } from "react";
import { render } from "react-dom";
import { dispatch, useStore } from "flux-native";

const LoadData = () => ({ merge, onCancel }) => {
  // mark data is loading
  merge({ loading: true });

  onCancel(() => {
    // mark nothing to load
    merge({ loading: false, data: undefined });
  });

  // assign test data after 2s
  setTimeout(merge, 2000, {
    loading: false,
    data: "Data loaded " + Math.random().toString(16)
  });
};

const App = () => {
  const [data, loading] = useStore(state => state.data, state => state.loading);
  const loadDataHandler = useRef();
  const [, forceRerender] = useState();
  const handleStatusChanged = () => {
    forceRerender({});
  };
  const handleLoad = () => {
    loadDataHandler.current = dispatch(LoadData);
    // register status changed listener
    loadDataHandler.current.onStatusChange(handleStatusChanged);
  };
  const handleCancel = () => {
    loadDataHandler.current && loadDataHandler.current.cancel();
  };
  const handleSuspend = () => {
    loadDataHandler.current && loadDataHandler.current.suspend();
  };
  const handleResume = () => {
    loadDataHandler.current && loadDataHandler.current.resume();
  };
  return (
    <>
      <p>
        <button onClick={handleLoad}>Load data</button>
        {loading && (
          <>
            <button onClick={handleCancel}>Cancel</button>
            {loadDataHandler.current.suspended() ? (
              <button onClick={handleResume}>Resume</button>
            ) : (
              <button onClick={handleSuspend}>Suspend</button>
            )}
          </>
        )}
      </p>
      <p>
        {loadDataHandler.current && loadDataHandler.current.suspended()
          ? "Suspended"
          : loading
          ? "Loading..."
          : data}
      </p>
    </>
  );
};

render(<App />, document.getElementById("root"));
```

## Dispatching action once

```jsx harmony
import { dispatchOnce } from "flux-native";

const Initialize = () => ({ data: [] });

dispatchOnce(Initialize);
```

## Dispatching action when component mount or unmount

```jsx harmony
import React from "react";
import { dispatchOnMount, dispatchOnUnmount } from "flux-native";

const OnComponentMount = (state, ...args) => {
  console.log("component mount", args);
};
const OnComponentUnmount = (state, ...args) => {
  console.log("component unmount", args);
};

const MyComponent = () => {
  dispatchOnMount(OnComponentMount, [1, 2, 3], ["deps"]);
  dispatchOnUnmount(OnComponentUnmount, [1, 2, 3], ["deps"]);
  return <div />;
};
```

## Handle state change

```jsx harmony
import { getState, subscribe } from "flux-native";

const unsubscribe = subscribe(() => {
  console.log('state changed', getState());
});

// unsubscribe()
```
