import { useState, useRef, useCallback, useEffect, useLayoutEffect, type DependencyList } from 'react';

export interface UseChatScrollOptions {
  dependencies?: DependencyList;
}

export function useChatScroll({ dependencies = [] }: UseChatScrollOptions = {}) {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const bottomAnchorRef = useRef<HTMLDivElement | null>(null);
  const [isAtBottom, setIsAtBottom] = useState<boolean>(true);

  const scrollToBottomInstant = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, []);

  const scrollToBottom = useCallback(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTo({
        top: scrollRef.current.scrollHeight,
        behavior: 'smooth',
      });
      setIsAtBottom(true);
    }
  }, []);

  const handleFeedScroll = useCallback(() => {
    if (!scrollRef.current) return;
    const { scrollTop, scrollHeight, clientHeight } = scrollRef.current;
    const atBottom = scrollHeight - scrollTop - clientHeight < 60;
    setIsAtBottom(atBottom);
  }, []);

  useLayoutEffect(() => {
    if (isAtBottom) {
      scrollToBottomInstant();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isAtBottom, scrollToBottomInstant, ...dependencies]);

  useEffect(() => {
    const feed = scrollRef.current;
    if (!feed || typeof ResizeObserver === 'undefined') return;

    const ro = new ResizeObserver(() => {
      if (isAtBottom && scrollRef.current) {
        scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
      }
    });

    ro.observe(feed);
    return () => ro.disconnect();
  }, [isAtBottom]);

  return {
    scrollRef,
    bottomAnchorRef,
    isAtBottom,
    setIsAtBottom,
    scrollToBottom,
    scrollToBottomInstant,
    handleFeedScroll,
  };
}
