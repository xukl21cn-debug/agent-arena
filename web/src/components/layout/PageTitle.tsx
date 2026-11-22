import { createContext, useContext, useEffect } from 'react';

type SetTitle = (title: string) => void;

/** Provided by AppShell so a page can say what the header should read. */
export const PageTitleContext = createContext<SetTitle>(() => undefined);

/**
 * Declares the shell header title for the route that renders this page.
 *
 * The title comes from the matched route, not from parsing the pathname: the
 * router matches case-insensitively and decodes segments, so any path-based
 * guess can disagree with what actually rendered.
 */
export function usePageTitle(title: string): void {
  const setTitle = useContext(PageTitleContext);
  useEffect(() => {
    setTitle(title);
  }, [setTitle, title]);
}
