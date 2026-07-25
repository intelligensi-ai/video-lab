declare module 'react' {
  export type SetStateAction<S> = S | ((prevState: S) => S);
  export type Dispatch<A> = (value: A) => void;
  export function useState<S = undefined>(): [S | undefined, Dispatch<SetStateAction<S | undefined>>];
  export function useState<S>(initialState: S | (() => S)): [S, Dispatch<SetStateAction<S>>];
  export function useEffect(effect: () => void | (() => void), dependencies?: readonly unknown[]): void;
  export function useMemo<T>(factory: () => T, deps: unknown[]): T;
  const React: { useState: typeof useState; useMemo: typeof useMemo; useEffect: typeof useEffect };
  export default React;
}
declare module 'react/jsx-runtime' { export const jsx: unknown; export const jsxs: unknown; export const Fragment: unknown; }
declare module 'react-dom/client' { export function createRoot(container: Element): { render(children: unknown): void }; }
declare namespace JSX { interface IntrinsicElements { [elemName: string]: any } interface IntrinsicAttributes { key?: string | number } }

declare namespace React { export type SetStateAction<S> = S | ((prevState: S) => S); export type Dispatch<A> = (value: A) => void; }
interface ImportMeta { env: Record<string, string | undefined> }
type Element = unknown;
