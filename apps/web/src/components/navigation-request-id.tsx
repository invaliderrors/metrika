'use client';

import { usePathname } from 'next/navigation';
import { useEffect } from 'react';
import { beginNavigation } from '@/lib/request-id/request-id';

/**
 * Renders nothing. It exists so that "a request ID per navigation" is true
 * rather than "a request ID per full page load", which is what module scope
 * gives you on its own in a single-page router.
 *
 * `useEffect` rather than render-time generation, and that is not a style
 * preference: generating during render would produce a different value on the
 * server than in the client's hydration pass, which is a hydration mismatch —
 * and would run on every re-render besides. The effect runs after commit, once
 * per pathname.
 *
 * `usePathname` and deliberately NOT `useSearchParams`. `useSearchParams` opts
 * a statically rendered route into client-side rendering unless it is wrapped
 * in a `<Suspense>` boundary, which is a real cost to pay for the one case it
 * adds: a same-path navigation that changes only the query string keeps the
 * previous ID. That case is worth knowing about and is not worth a suspense
 * boundary around the whole application.
 *
 * The `pathname` dependency is what makes this fire; the value is otherwise
 * unused, which is exactly why it is passed to the dependency array rather than
 * read inside the effect.
 */
export function NavigationRequestId(): null {
  const pathname = usePathname();

  useEffect(() => {
    beginNavigation();
  }, [pathname]);

  return null;
}
