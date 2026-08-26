// Minimal React type declarations for compilation.
//
// The actual React runtime is loaded via `require('react')` from DSH's
// module system at runtime. We only need loose types here so tsc is happy.

declare module 'react' {
  export type ReactNode = any;
  export type ReactElement = any;
  export type Ref<T> = { current: T | null } | ((instance: T | null) => void) | null;
  export interface ForwardRefExoticComponent<P> {
    (props: P): ReactNode;
    displayName?: string;
  }
  export function forwardRef<T, P = any>(
    render: (props: P, ref: Ref<T>) => ReactNode,
  ): ForwardRefExoticComponent<P & { ref?: Ref<T> }>;
  export function useRef<T>(initial: T | null): { current: T | null };
  export function useImperativeHandle<T>(
    ref: Ref<T>,
    init: () => T | null,
  ): void;
  export function useEffect(
    fn: () => void | (() => void),
    deps?: ReadonlyArray<unknown>,
  ): void;
  export function createElement(
    type: any,
    props?: any,
    ...children: any[]
  ): ReactNode;
  const React: { createElement: typeof createElement };
  export default React;
}
