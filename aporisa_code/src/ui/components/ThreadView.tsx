import { useEffect, useLayoutEffect, useRef } from "react";
import { useUi } from "../context.tsx";
import type { ThreadState } from "../state/store.ts";
import { Composer } from "./Composer.tsx";
import { TopBar } from "./TopBar.tsx";
import { TurnView } from "./TurnView.tsx";

export function ThreadView({ thread }: { thread: ThreadState }) {
  const { bridge, state } = useUi();
  const scroller = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);
  const approvals = state.approvals.filter((request) => request.params.threadId === thread.info.id);
  const lastTurn = thread.turns[thread.turns.length - 1];

  // Follow new output while the view is scrolled to the bottom.
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element && pinned.current) element.scrollTop = element.scrollHeight;
  });
  useEffect(() => {
    const element = scroller.current;
    if (!element) return;
    const onScroll = () => {
      pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
    };
    element.addEventListener("scroll", onScroll);
    return () => element.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="thread">
      <TopBar thread={thread} />
      <div className="turns" ref={scroller}>
        <div className="turns-inner">
          {thread.turns.map((turn) => (
            <TurnView key={turn.id} turn={turn} approvals={turn.id === lastTurn?.id ? approvals : approvals.filter((request) => request.params.turnId === turn.id)} />
          ))}
        </div>
      </div>
      <Composer
        running={thread.info.running}
        onSend={async (message) => {
          await bridge.request("turn/start", { threadId: thread.info.id, ...message });
        }}
        onStop={() => void bridge.request("turn/interrupt", { threadId: thread.info.id })}
      />
    </div>
  );
}
