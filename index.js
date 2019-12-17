import {
  useState,
  useRef,
  useEffect,
  useMemo,
  lazy,
  createElement,
  Suspense,
  Fragment,
  memo
} from "react";

let reactEnv = process.env.REACT_APP_ENV
  ? process.env.REACT_APP_ENV.trim() + "_"
  : "";
let envCache = {};
const isContextProp = "__CONTEXT__" + Math.random().toString(36);
const syncIdProp = "__SYNC_ID__";
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

let currentId = 1;
let currentState = {};
let dispatchOnceKey = generateDispatchOnceKey();

function uniqueId() {
  return `${currentId++}-${Math.random().toString(36)}-${new Date().getTime()}`;
}

function notify(action) {
  mainPublisher.notify(action);
}

function createPublisher() {
  const subscriptions = new Set();
  return {
    notify(...args) {
      for (const subscription of subscriptions) {
        if (subscription.__suspended) continue;
        subscription(...args);
      }
    },
    subscribe(subscription) {
      subscriptions.add(subscription);
      return Object.assign(() => subscriptions.delete(subscription), {
        suspend() {
          subscription.__suspended = true;
        },
        resume() {
          subscription.__suspended = false;
        }
      });
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
    [isContextProp]: true,
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
  let propName;
  if (typeof getterOrPropName !== "function") {
    propName = getterOrPropName;
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
    let defaultValueCache;
    getter = state =>
      prop in state
        ? state[prop]
        : defaultValueCache
        ? defaultValueCache.value
        : (defaultValueCache = {
            value:
              typeof defaultValue === "function" ? defaultValue() : defaultValue
          }).value;
  }
  const accessor = Object.assign(
    function(state, value, original) {
      if (arguments.length < 2) {
        return getter(state);
      }
      if (!reducer) {
        throw new Error("No reducer presents");
      }
      return reducer(state, value, original);
    },
    {
      isAccessor: true,
      propName,
      select: (...props) => (...args) =>
        props.reduce((value, prop) => value[prop], accessor(...args))
    }
  );

  return accessor;
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

/**
 * subscribe(changeDetector, subscription)
 * subscribe(subscription, isWatcher)
 * @param args
 * @return {function(): boolean}
 */
export function subscribe(...args) {
  if (typeof args[1] === "function") {
    const [changeDetector, subscription] = args;
    const isAccessor = changeDetector.isAccessor === true;
    let prevValue = isAccessor ? getState(changeDetector) : undefined;
    const wrappedSubscription = isAccessor
      ? (...args) => {
          const currentValue = getState(changeDetector);
          if (prevValue !== currentValue) {
            prevValue = currentValue;
            return subscription(...args);
          }
        }
      : (...args) => {
          if (changeDetector(currentState)) {
            return subscription(...args);
          }
        };
    return mainPublisher.subscribe(wrappedSubscription);
  } else {
    const [subscription, isWatcher] = args;
    if (isWatcher) {
      return mainWatchers.subscribe(subscription);
    }
    return mainPublisher.subscribe(subscription);
  }
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

export function createSelector(...args) {
  const selector = args.pop();
  const inputSelectors = args;
  let lastInputValues;
  let lastResult;
  return function(...inputs) {
    const inputValues = inputSelectors.map(inputSelector =>
      inputSelector(...inputs)
    );
    if (
      !lastInputValues ||
      lastInputValues.some((value, index) => value !== inputValues[index])
    ) {
      lastInputValues = inputValues;
      lastResult = selector(...inputValues);
    }
    return lastResult;
  };
}

export function getValue(state, selector) {
  if (arguments.length < 2) {
    return getValues(currentState, [state])[0];
  }
  return getValues(currentState, [selector])[0];
}

/**
 * get react app environment variable value
 * no REACT_APP_ prefix needed
 * example:
 * .env.production
 *  REACT_APP_PRO_DB=production_db
 *  REACT_APP_DEV_DB=develop_db
 *
 *  if we run "REACT_APP_ENV=PRO npm build"
 *  env('db') => production_db
 *
 *  if we run "REACT_APP_ENV=DEV npm build"
 *  env('db') => develop_db
 * @param name
 * @return {string}
 */
export function env(name) {
  const upperKeyName = name.toString().toUpperCase();
  const fullKeyName = reactEnv + upperKeyName;
  let value = internalEnv(fullKeyName);
  // not exist
  if (value === false) {
    // try get env variable without REACT_APP_ENV prefix
    value = internalEnv(upperKeyName);
    if (value !== false) {
      envCache[fullKeyName] = value;
    }
  }
  return value === false ? "" : value;
}

function internalEnv(name) {
  const keyName = `REACT_APP_${name}`;
  if (keyName in envCache) {
    return envCache[keyName];
  }
  let value = keyName in process.env ? process.env[keyName] : false;
  if (value !== false && value.indexOf("@{") !== -1) {
    // replace tokens ${other_env_name}
    // make sure no circular ref
    envCache[keyName] = "";
    value = value.replace(/@\{([^}]+)}/g, (m, v) => env(v));
  }
  return (envCache[keyName] = value);
}

export function init(initializer) {
  if (typeof initializer !== "function") {
    dispatch(() => initializer);
  } else {
    dispatchOnce(initializer);
  }
}

export function lazySubscribe(changeDetector, lazyLoader) {
  let promise;
  return subscribe(changeDetector, (...args) => {
    if (!promise) {
      promise = lazyLoader();
    }

    promise.then(module => module.default(...args));
  });
}

export function compose(...functions) {
  if (functions.length === 0) {
    return arg => arg;
  }

  if (functions.length === 1) {
    return functions[0];
  }

  return functions.reduce((a, b) => (...args) => a(b(...args)));
}

export function hoc(...callbacks) {
  return callbacks.reduce(
    (nextHoc, callback) => Component => {
      const MemoComponent = memo(Component);

      return props => {
        // callback requires props and Comp, it must return React element
        if (callback.length > 1) {
          return callback(props, MemoComponent);
        }
        let newProps = callback(props);
        if (newProps === false) return null;
        if (!newProps) {
          newProps = props;
        }

        return createElement(MemoComponent, newProps);
      };
    },
    Component => Component
  );
}

export function getSyncId(obj) {
  return obj[syncIdProp];
}
//
// export function autoSync(
//   accessor,
//   syncer,
//   { debounce = 0, $dispatch = dispatch } = {}
// ) {
//   const debouncedSyncer = createDebounce(async () => {
//     const changes = accessor(currentState);
//     const unsyncedItems = changes.filter(change => {
//       if (change && !getSyncId(change)) {
//         change[syncIdProp] = uniqueId();
//         return true;
//       }
//       return false;
//     });
//
//     if (unsyncedItems.length) {
//       let mergeData;
//       try {
//         mergeData = await syncer(
//           unsyncedItems.map(({ [syncIdProp]: skippedProp, ...item }) => item)
//         );
//       } finally {
//         const currentChanges = accessor(currentState);
//         // if there is something need to merge to current changes
//         if (mergeData) {
//           $dispatch(() => ({ set }) => {
//             set([
//               accessor,
//               currentChanges => {
//                 let hasChange = false;
//                 let newChanges = currentChanges.map(currentChange => {
//                   const currentSyncId = getSyncId(currentChange);
//                   // not sync item
//                   if (!currentSyncId) {
//                     return currentChange;
//                   }
//                   const index = unsyncedItems.findIndex(
//                     x => getSyncId(x) === currentSyncId
//                   );
//                   // this change might be belong to another sync session, not current
//                   if (index === -1) {
//                     return currentChange;
//                   }
//                   const newChange = { ...currentChange, ...mergeData[index] };
//                   delete newChange[syncIdProp];
//                   hasChange = true;
//                   return newChange;
//                 });
//                 return hasChange ? newChanges : currentChanges;
//               }
//             ]);
//           });
//         } else {
//           // just cleanup sync id
//           unsyncedItems.forEach(syncItem => {
//             const currentChange = currentChanges.find(
//               x => getSyncId(x) === getSyncId(syncItem)
//             );
//             if (currentChange) {
//               delete currentChange[syncIdProp];
//             }
//           });
//         }
//       }
//     }
//   }, debounce);
//   return subscribe(accessor, debouncedSyncer);
// }

export function connect(
  { pre = [], post = [], store = {}, actions = {}, memo = {} },
  customizer
) {
  const actionDispatchers = {};
  const $useStore = useStore;
  const $useMemo = useMemo;
  const storeSelectors = Object.values(store);
  const storeKeys = Object.keys(store);
  const propModifiers = Object.entries(memo).map(([propName, args]) => {
    const selector = args.pop();
    return props => {
      const memoInputs = args.map(x => props[x]);
      props[propName] = $useMemo(() => selector(...memoInputs), memoInputs);
    };
  });
  Object.entries(actions).forEach(([key, action]) => {
    // want to prepend some args before dispatching
    if (Array.isArray(action)) {
      const [innerAction, ...prependArgs] = action;
      actionDispatchers[key] = (...args) =>
        dispatch(innerAction, ...prependArgs, ...args);
    } else {
      actionDispatchers[key] = (...args) => dispatch(action, ...args);
    }
  });
  return compose(
    ...pre,
    hoc(props => {
      const newProps = { ...props, ...actionDispatchers };
      const propValues = $useStore(...storeSelectors);
      storeKeys.forEach(
        (propName, index) => (newProps[propName] = propValues[index])
      );
      propModifiers.forEach(modifier => modifier(newProps));
      Object.assign(newProps, props);
      if (!customizer) return newProps;
      return customizer(newProps);
    }),
    ...post
  );
}

export function async(action, ...args) {
  let onResolve, onReject;
  const isMultiple = Array.isArray(action);
  const actions = isMultiple ? action : [[action, ...args]];

  const execute = async context => {
    const promises = actions.map(
      ([action, ...args]) =>
        new Promise((resolve, reject) => {
          const wrapper = (...args) => {
            // this wrapper acts like reducer, so we not return anything to avoid state changing
            action(...args);
          };
          context.dispatch(wrapper, { ...context, resolve, reject }, ...args);
        })
    );
    return Promise.all(promises);
  };
  const func = function() {
    if (arguments[0] && arguments[0][isContextProp] === true) {
      // is context
      const context = arguments[0];
      execute(context).then(
        results =>
          onResolve &&
          context.dispatch(onResolve, isMultiple ? results : results[0]),
        error => onReject && context.dispatch(onReject, error)
      );
      return;
    }
    Object.assign(func, {
      onResolve: (onResolve = arguments[0]),
      onReject: (onReject = arguments[1])
    });

    return func;
  };
  return Object.assign(func, {
    actions
  });
}

export function __TEST__env(newReactEnv = "", newEnvCache = {}) {
  reactEnv = newReactEnv ? newReactEnv + "_" : "";
  envCache = newEnvCache;
}
//
// export function createDispatcher(action, { in: input, out: output } = {}) {
//   return function (...args) {
//
//   }
// }

dispatch.async = createDispatchAsync(dispatch);
