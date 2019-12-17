import {
  __TEST__env,
  cleanup,
  createAccessor,
  dispatch,
  getState,
  getValue,
  subscribe,
  env,
  init,
  async
} from "../index";

beforeEach(() => {
  cleanup();

  // cleanup REACT_APP**
  Object.keys(process.env).forEach(
    key => /^REACT_APP/.test(key) && delete process.env[key]
  );
});

const delayIn = (milliseconds, result) =>
  new Promise(resolve => setTimeout(resolve, milliseconds, result));

test("Singleton feature should work properly", async () => {
  dispatch(() => ({ count: 0 }));

  const Increase = state => {
    console.log("increase action dispatching");
    return { ...state, count: state.count + 1 };
  };

  const SingletonIncrease = () => ({ dispatch }) => () => {
    if (!dispatch) {
      debugger;
    }
    console.log("singleton action dispatching");
    return new Promise(resolve =>
      setTimeout(() => {
        dispatch(Increase);
        resolve();
      }, 100)
    );
  };

  dispatch(SingletonIncrease);
  dispatch(SingletonIncrease);
  dispatch(SingletonIncrease);
  expect(getState().count).toBe(0);

  await delayIn(250);

  expect(getState().count).toBe(1);
});

test("Should support suspending/resuming on nested action dispatching", async () => {
  const ParentAction = () => ({ dispatch }) => {
    dispatch(ChildAction);
  };

  const ChildAction = () => ({ set, suspend, resume }) => {
    setTimeout(set, 200, { data: 1 });
    setTimeout(suspend, 100);
    setTimeout(resume, 300);
  };

  dispatch(() => ({ data: 0 }));
  const parentActionHandler = dispatch(ParentAction);
  expect(getState().data).toBe(0);
  parentActionHandler.suspend();
  await delayIn(400);
  expect(getState().data).toBe(0);
  parentActionHandler.resume();
  expect(getState().data).toBe(1);
});

test("Should support transaction without conflict", async () => {
  const stateChanges = ["", "A", "B", "C", "A"];

  const ActionThatUseTransaction = () => ({ set, transaction }) => {
    set({ state: "A" });
    const { commit, rollback } = transaction(
      // we only track changes on state prop
      ({ state }) => ({ state })
    );

    set({ state: "B" });
    set({ state: "C" });
    commit();
    setTimeout(() => rollback(), 200);
  };

  subscribe(current => {
    expect(current.state).toBe(stateChanges.shift());
  }, true);

  dispatch(() => ({ state: "" }));

  dispatch(ActionThatUseTransaction);
  await delayIn(300);
  expect(stateChanges.length).toBe(0);
});

test("Should support transaction with conflict", async () => {
  const stateChanges = ["", "A", "B", "C", "D", "rollback"];

  const ActionThatUseTransaction = () => ({ set, transaction }) => {
    set({ state: "A" });
    const { commit, rollback } = transaction(
      // we only track changes on state prop
      ({ state }) => ({ state })
    );

    set({ state: "B" });
    set({ state: "C" });

    commit();
    set({ state: "D" });

    setTimeout(
      () =>
        rollback(() =>
          // resolve conflict manually
          ({ state: "rollback" })
        ),
      200
    );
  };

  subscribe(current => {
    expect(current.state).toBe(stateChanges.shift());
  }, true);

  dispatch(() => ({ state: "" }));

  dispatch(ActionThatUseTransaction);
  await delayIn(300);
  expect(stateChanges.length).toBe(0);
});

test("createAccessor(prop, defaultValue) getter", () => {
  const $count = createAccessor("count", 1);

  expect($count({})).toBe(1);
  expect($count({ count: 2 })).toBe(2);
});

test("createAccessor(prop, defaultValue) setter", () => {
  const $count = createAccessor("count", 1);
  const $prop1 = createAccessor("prop1");
  const $prop2 = createAccessor("prop2");
  expect($count({}, 1)).toEqual({});
  expect($count({}, 2)).toEqual({ count: 2 });
  const original = {};
  const change1 = $prop1(original, 1);
  const change2 = $prop2(change1, 1);

  expect(change1).not.toBe(original);
  expect(change1).not.toBe(change2);
  expect(change2).not.toBe(original);
  expect(change2).toEqual({ prop1: 1, prop2: 1 });

  const change3 = $prop1(original, 1, original);
  const change4 = $prop2(change3, 1, original);

  expect(change3).not.toBe(original);
  expect(change3).toBe(change4);
  expect(change4).toEqual({ prop1: 1, prop2: 1 });
});

test("CounterApp with accessor", () => {
  const $count = createAccessor("count", 0);
  const Increase = () => [$count, current => current + 1];
  dispatch(Increase);
  dispatch(Increase);
  expect(getValue($count)).toBe(2);
});

test("env", () => {
  process.env.REACT_APP_PRO_VAR = "100";
  process.env.REACT_APP_DEV_VAR = "200";
  process.env.REACT_APP_COMMON = "common";
  process.env.REACT_APP_TEMPLATE = "Amount = @{var}";

  __TEST__env("PRO");
  expect(env("var")).toBe("100");
  expect(env("common")).toBe("common");
  expect(env("template")).toBe("Amount = 100");

  __TEST__env("DEV");
  expect(env("var")).toBe("200");
  expect(env("common")).toBe("common");
  expect(env("template")).toBe("Amount = 200");
});

test("async()", async () => {
  const $data = createAccessor("data");
  const $done = createAccessor("done");
  init([$data, "nothing"]);
  const LoadDataPromiseFactory = (state, { resolve, reject }, params) =>
    delayIn(100, `data:${params}`).then(resolve, reject);
  const LoadDataAsync = () =>
    async(LoadDataPromiseFactory, 100)(
      (state, result) => [[$done, true], [$data, result]],
      (state, error) => console.log(error)
    );
  dispatch(LoadDataAsync);
  await delayIn(200);
  expect(getState()).toEqual({ data: "data:100", done: true });
});

//
// test("autoSync", async () => {
//   const $cart = createAccessor("cart");
//   let syncItems = [];
//   dispatch(() => [$cart, []]);
//
//   const AddToCart = (state, ...items) => {
//     return [$cart, [...$cart(state), ...items]];
//   };
//
//   autoSync(
//     $cart,
//     items => {
//       syncItems = items;
//       console.log(items.length);
//     },
//     { debounce: 50 }
//   );
//
//   dispatch(AddToCart, { productId: 1 });
//
//   expect(getState()).toEqual({ cart: [{ productId: 1 }] });
//
//   await delayIn(100);
//
//   dispatch(AddToCart, { productId: 2 }, { productId: 3 });
//
//   await delayIn(100);
//
//   expect(syncItems).toEqual([{ productId: 2 }, { productId: 3 }]);
//
//   await delayIn(2000);
// }, 5000);
