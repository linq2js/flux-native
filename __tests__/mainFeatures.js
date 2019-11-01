import { cleanup, dispatch, getState, subscribe } from "../index";

beforeEach(() => {
  cleanup();
});

const delayIn = milliseconds =>
  new Promise(resolve => setTimeout(resolve, milliseconds));

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
