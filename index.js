import {
  useState,
  useRef,
  useEffect,
  useMemo,
  lazy,
  createElement,
  Suspense,
  Fragment
} from "react";

const defaultStateValidator = () => true;
const defaultSafeStateValidator = (prev, next) => prev === next;
const mainPublisher = createPublisher();
const mainWatchers = createPublisher();

const eventNames = {
  cancel: "cancel",
  cancelled: "cancelled",
  resume: "resume",
  suspend: "suspend"
};

let currentState = {};
let dispatchOnceKey = generateDispatchOnceKey();

function notify(action) {
  mainPublisher.notify(action);
}

function createPublisher() {
  const subscriptions = new Set();
  return {
    notify(...args) {
      for (const subscription of subscriptions) {
        subscription(...args);
      }
    },
    subscribe(subscription) {
      subscriptions.add(subscription);
      return () => subscriptions.delete(subscription);
    },
    unsubscribeAll() {
      subscriptions.clear();
    }
  };
}

function createDebounce(func, interval = 0, extend) {
  let timerId;
  return Object.assign((...args) => {
    clearTimeout(timerId);
    timerId = setTimeout(func, interval, ...args);
  }, extend);
}

function generateDispatchOnceKey() {
  return "__dispatched" + (new Date().getTime() * Math.random()).toString(16);
}

function dispatchAsyncAction(action, originalAction, parentContext) {
  const context = createActionContext(action, originalAction, parentContext);

  try {
    context.__beginSyncDispatching();
    const result = action(context);

    if (typeof result === "function") {
      context.__awaitSingleton(result);
    }

    context.__configured = true;
  } finally {
    context.__endSyncDispatching();
  }

  return context;
}

function reduceState(reducers, state) {
  // reduceState([accessor, value])
  if (reducers.length === 2 && typeof reducers[0] === "function") {
    reducers = [reducers];
  }
  return reducers.reduce(
    (state, [accessor, value]) => accessor(state, value, state),
    state
  );
}

export function createActionContext(
  action,
  originalAction = action,
  parentContext
) {
  let savedState;
  let prevState = currentState;
  // at first time of action executing phase, we skip notification
  // make sure only one notification execute after action dispatching if state changed
  let skipNotification = true;
  const syncDispatch = (action, ...args) => {
    if (!context.__isValid()) {
      return context;
    }
    if (context.__suspended && !context.__cancelling) {
      context.__dispatchQueue.push([action, args]);
      return context;
    }
    return internalDispatch(action, args, context, skipNotification);
  };
  const asyncDispatch = syncDispatch;
  let dispatchWrapper = syncDispatch;
  syncDispatch.async = createDispatchAsync(dispatchWrapper);
  asyncDispatch.async = createDispatchAsync(dispatchWrapper);

  const context = {
    __events: {},
    __validator: defaultStateValidator,
    __dispatchQueue: [],
    __addEventListener(event, listener) {
      if (!(event in context.__events)) {
        context.__events[event] = createPublisher();
      }
      context.__events[event].subscribe(listener);
    },
    __dispatchEvent(event, ...args) {
      if (!(event in context.__events)) {
        return;
      }
      context.__events[event].notify(...args);
    },
    __isValid() {
      return (
        (!parentContext || parentContext.__isValid()) &&
        !context.__cancelled &&
        context.__validator(currentState, prevState)
      );
    },
    __beginSyncDispatching() {
      savedState = currentState;
    },
    __endSyncDispatching() {
      // re-enable notification for async actions
      skipNotification = false;
      // apply debouncing for async actions
      dispatchWrapper = asyncDispatch;

      // perform notifications if state changed
      if (savedState !== currentState) {
        notify(originalAction);
      }
    },
    __validateConfiguration() {
      if (context.__configured) {
        throw new Error("Cannot configure async action this time");
      }
    },
    __awaitSingleton(promiseFactory) {
      if (originalAction.__executing) return;

      async function internalAwait() {
        try {
          await promiseFactory();
        } finally {
          originalAction.__executing = false;
        }
      }

      originalAction.__executing = true;
      return internalAwait();
    },
    get: getState,
    set(nextState, ...args) {
      dispatchWrapper(() =>
        typeof nextState === "function"
          ? nextState(currentState, ...args)
          : // is list of accessors
          Array.isArray(nextState)
          ? reduceState(nextState, currentState)
          : nextState
      );

      return context;
    },
    reduce(reducers) {
      return context.set(reduceState(reducers, currentState));
    },
    merge(props, ...args) {
      dispatchWrapper(prevState => {
        const changes =
          typeof props === "function" ? props(prevState, ...args) : props;

        let updatedState = prevState;
        Object.keys(changes).forEach(key => {
          if (changes[key] !== prevState[key]) {
            if (updatedState === prevState) {
              updatedState = { ...prevState };
            }
            updatedState[key] = changes[key];
          }
        });
        return updatedState;
      });
      return context;
    },
    async each(iterable, iterator) {
      let index = 0;
      for (const item of iterable) {
        const promiseResult = await item;
        if (!context.__isValid()) return;
        iterator(promiseResult, index++);
      }

      return context;
    },
    async pipe(actions, seed, ...args) {
      for (const action of actions) {
        seed = await action(seed, ...args);
      }
      return seed;
    },
    safeState() {
      context.validator(defaultSafeStateValidator);
      return context;
    },
    suspend() {
      if (context.__cancelled) return;
      context.__suspended = true;
      context.__dispatchEvent(eventNames.suspend);

      return context;
    },
    suspended() {
      return context.__suspended;
    },
    resume() {
      if (context.__cancelled || !context.__suspended) return;
      context.__suspended = false;

      context.__dispatchEvent(eventNames.resume);

      if (context.__dispatchQueue.length) {
        const copyDispatchQueue = context.__dispatchQueue.slice(0);
        context.__dispatchQueue.length = 0;
        if (parentContext && parentContext.__suspended) {
          parentContext.__dispatchQueue.push(...copyDispatchQueue);
        } else {
          copyDispatchQueue.forEach(([action, args]) => {
            context.dispatch(action, ...args);
          });
        }
      }
      return context;
    },
    cancel(reason) {
      if (context.__cancelled) return;
      dispatchWrapper = syncDispatch;
      try {
        context.__cancelling = true;
        context.__dispatchEvent(eventNames.cancel, reason);
      } finally {
        delete context.__cancelling;
        dispatchWrapper = asyncDispatch;
      }
      context.__cancelled = true;
      context.__dispatchEvent(eventNames.cancelled, reason);
      return context;
    },
    cancelled() {
      return !!context.__cancelled;
    },
    validator(validator) {
      context.__validateConfiguration();
      context.__validator = validator;
      return context;
    },
    check(validator) {
      return context.validator(validator);
    },
    dispatch(...args) {
      return dispatchWrapper(...args);
    },
    transaction(selector) {
      const originalState = selector ? getValues([selector])[0] : currentState;
      let committedState = originalState;
      let isCommitted = false;
      let isRolledBack = false;

      function commit() {
        if (isCommitted) return;
        if (isRolledBack) {
          // show warn
          return;
        }
        isCommitted = true;
        committedState = selector ? getValues([selector])[0] : currentState;
      }

      function rollback(actionToResolveConflict) {
        function resolveConflict() {
          actionToResolveConflict &&
            context.dispatch(actionToResolveConflict, originalState);
        }
        if (!isCommitted) {
          // show warn
          return;
        }

        if (isRolledBack) {
          return;
        }
        isRolledBack = true;
        // compare current state and saved state as prop by prop
        const hasChange = Object.keys(committedState).some(
          key => committedState[key] !== currentState[key]
        );
        // let developer handles this case manually
        if (hasChange) {
          return resolveConflict();
        }
        if (selector) {
          context.merge(originalState);
        } else {
          context.set(originalState);
        }
      }

      return {
        commit,
        rollback
      };
    },
    onSuspend(listener) {
      context.__addEventListener(eventNames.suspend, listener);
    },
    onResume(listener) {
      context.__addEventListener(eventNames.resume, listener);
    },
    onCancel(listener) {
      context.__addEventListener(eventNames.cancel, listener);
    },
    onCancelled(listener) {
      context.__addEventListener(eventNames.cancelled, listener);
    },
    onStatusChange(listener) {
      context.__addEventListener(eventNames.suspend, listener);
      context.__addEventListener(eventNames.resume, listener);
    },
    promise(action, ...args) {
      return new Promise((resolve, reject) => {
        context.dispatch(action, { ...context, resolve, reject }, ...args);
      });
    }
  };

  return context;
}

export function useStore(...selectors) {
  const [, forceUpdate] = useState();
  const prevValuesRef = useRef([]);
  const selectorsRef = useRef(selectors);
  const isUnmountRef = useRef(false);

  useEffect(() => {
    function checkForUpdates() {
      if (isUnmountRef.current) return;

      const currentValues = getValues(selectorsRef.current);

      if (
        currentValues.length !== prevValuesRef.current.length ||
        currentValues.some(
          (value, index) => value !== prevValuesRef.current[index]
        )
      ) {
        forceUpdate({});
      }
    }

    checkForUpdates();

    const unsubscribe = subscribe(checkForUpdates);

    return () => {
      unsubscribe();
      isUnmountRef.current = true;
    };
  }, []);

  prevValuesRef.current = getValues(selectors);

  return prevValuesRef.current;
}

export function createAccessor(getterOrPropName, reducer, defaultValue) {
  let getter = getterOrPropName;
  if (typeof getterOrPropName !== "function") {
    defaultValue = reducer;
    const prop = getter;
    reducer = (state, value, original) => {
      const current = getter(state);
      if (typeof value === "function") {
        value = value(current);
      }
      if (current === value) return state;
      if (!original || state === original) {
        state = {
          ...state
        };
      }
      state[prop] = value;
      return state;
    };
    getter = state => (prop in state ? state[prop] : defaultValue);
  }
  return function(state, value, original) {
    if (arguments.length < 2) {
      return getter(state);
    }
    if (!reducer) {
      throw new Error("No reducer presents");
    }
    return reducer(state, value, original);
  };
}

export function cleanup() {
  currentState = {};
  mainPublisher.unsubscribeAll();
  mainWatchers.unsubscribeAll();
  dispatchOnceKey = generateDispatchOnceKey();
}

export function getState(selector) {
  if (selector) {
    return getValues([selector])[0];
  }
  return currentState;
}

export function dispatch(action, ...args) {
  return internalDispatch(action, args);
}

export function dispatchOnce(action, ...args) {
  if (action[dispatchOnceKey]) return;
  action[dispatchOnceKey] = true;
  dispatch(action, ...args);
}

export function subscribe(subscription, isWatcher) {
  if (isWatcher) {
    return mainWatchers.subscribe(subscription);
  }
  return mainPublisher.subscribe(subscription);
}

export function useCallbacks(inputs, ...callbacks) {
  return useMemo(() => callbacks, inputs || []);
}

export function dispatchOnMount(action, args = [], inputs = []) {
  useEffect(() => {
    dispatch(action, ...args);
  }, inputs);
}

export function dispatchOnMountIf(condition, action, args = [], inputs = []) {
  useEffect(() => {
    if (typeof condition === "function") {
      if (!condition()) return;
    } else if (!condition) {
      return;
    }
    dispatch(action, ...args);
  }, inputs);
}

export function dispatchOnUnmount(action, args = [], inputs = []) {
  useEffect(
    () => () => {
      dispatch(action, ...args);
    },
    inputs
  );
}

export function dispatchOnUnmountIf(condition, action, args = [], inputs = []) {
  useEffect(
    () => () => {
      if (typeof condition === "function") {
        if (!condition()) return;
      } else if (!condition) {
        return;
      }
      dispatch(action, ...args);
    },
    inputs
  );
}

export function loadableComponent(
  componentImport,
  { onLoading, onLoaded, ...options } = {}
) {
  const lazyComponent = lazy(componentImport);
  const loadingAction = () => ({ dispatch }) => dispatch(onLoading);
  const loadedAction = () => ({ dispatch }) => dispatch(onLoaded);
  const loadedComponent = () => {
    dispatchOnce(loadedAction);
    return createElement(Fragment);
  };
  return function(props) {
    onLoading && dispatchOnce(loadingAction);

    return createElement(
      Suspense,
      {
        fallback: "",
        ...options
      },
      createElement(lazyComponent, props),
      ...(onLoaded ? [createElement(loadedComponent)] : [])
    );
  };
}

function createDispatchAsync(dispatch) {
  return function(promiseFactory, { success, failure } = {}, ...args) {
    async function internalAwait() {
      try {
        const payload = await promiseFactory(...args);
        success && typeof success === "function"
          ? dispatch(success, payload)
          : dispatch(state => ({ ...state, [success]: payload }));
      } catch (e) {
        failure && typeof failure === "function"
          ? dispatch(failure, e)
          : dispatch(state => ({ ...state, [failure]: e }));
      }
    }

    return internalAwait();
  };
}

function internalDispatch(action, args, parentContext, skipNotification) {
  let nextState = action(currentState, ...args);
  if (typeof nextState === "function") {
    return dispatchAsyncAction(nextState, action, parentContext);
  } else if (Array.isArray(nextState)) {
    nextState = reduceState(nextState, currentState);
  }

  if (nextState) {
    if (currentState !== nextState) {
      currentState = nextState;
      mainWatchers.notify(currentState, action);
      !skipNotification && notify(action);
    }
  } else {
    // skip empty state
  }

  return createActionContext(action);
}

export function getValues(...args) {
  if (args.length < 2) {
    return getValues(currentState, args[0]);
  }
  const [state, selectors] = args;
  return selectors.map(selector =>
    typeof selector === "string" ? state[selector] : selector(state)
  );
}

export function getValue(state, selector) {
  if (arguments.length < 2) {
    return getValues(currentState, [state])[0];
  }
  return getValues(currentState, [selector])[0];
}
//
// export function createDispatcher(action, { in: input, out: output } = {}) {
//   return function (...args) {
//
//   }
// }

dispatch.async = createDispatchAsync(dispatch);
