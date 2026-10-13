import { createContext, useContext, useEffect, useState, useSyncExternalStore } from 'react';

/**
 * Values the mounted screens report to their layout, in the order the
 * screens mounted: in a stack, the last one is the screen on top. Screens a
 * stack keeps mounted behind the current one keep their reports until they
 * unmount, so a layout picks the report of the screen that is shown.
 */
class ScreenReports<T> {
  private entries = new Map<object, T>();
  private listeners = new Set<() => void>();
  private snapshot: T[] = [];

  set(token: object, value: T) {
    if (this.entries.has(token) && Object.is(this.entries.get(token), value)) return;
    this.entries.set(token, value);
    this.changed();
  }

  delete(token: object) {
    if (this.entries.delete(token)) this.changed();
  }

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.snapshot;

  private changed() {
    this.snapshot = [...this.entries.values()];
    for (const listener of this.listeners) listener();
  }
}

/**
 * A kind of report: screens send theirs with `useReport` (a stable value, a
 * primitive or memoized), the layout that owns them reads all of them with
 * `useReports` and passes them down with `Provider`. Without a provider (a
 * screen rendered on its own) reports go nowhere.
 */
export function createScreenReports<T>() {
  const Context = createContext(new ScreenReports<T>());

  function useReport(value: T) {
    const reports = useContext(Context);
    const [token] = useState(() => ({}));
    useEffect(() => () => reports.delete(token), [reports, token]);
    useEffect(() => reports.set(token, value), [reports, token, value]);
  }

  function useReports() {
    const [reports] = useState(() => new ScreenReports<T>());
    const values = useSyncExternalStore(
      reports.subscribe,
      reports.getSnapshot,
      reports.getSnapshot,
    );
    return { reports, values };
  }

  return { Provider: Context.Provider, useReport, useReports };
}
