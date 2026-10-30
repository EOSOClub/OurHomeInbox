// Accessible tabs, following the WAI-ARIA tabs pattern: a tablist of buttons,
// one tab in the Tab key order at a time, Left/Right arrows (and Home/End)
// move between tabs and select them. Only the selected panel is rendered, so
// a heavy panel (the email frame) is not built until it is opened.

import { useId, useRef, useState, type KeyboardEvent, type ReactNode } from "react";

export interface TabItem {
  id: string;
  label: string;
  /** A count shown next to the label, for example the number of attachments. */
  count?: number;
  render: () => ReactNode;
}

interface TabsProps {
  items: readonly TabItem[];
  /** Names the set of tabs for screen readers. */
  label: string;
  initialId?: string;
}

export function Tabs({ items, label, initialId }: TabsProps) {
  const baseId = useId();
  const [selectedId, setSelectedId] = useState(initialId ?? items[0]?.id ?? "");
  const tabRefs = useRef(new Map<string, HTMLButtonElement>());

  const selected = items.find((item) => item.id === selectedId) ?? items[0];
  if (!selected) return null;
  const tabId = (id: string) => `${baseId}-tab-${id}`;
  const panelId = (id: string) => `${baseId}-panel-${id}`;

  function select(index: number) {
    const item = items[(index + items.length) % items.length];
    if (!item) return;
    setSelectedId(item.id);
    tabRefs.current.get(item.id)?.focus();
  }

  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    const current = items.findIndex((item) => item.id === selected?.id);
    const moves: Record<string, number> = { ArrowRight: current + 1, ArrowLeft: current - 1, Home: 0, End: items.length - 1 };
    const next = moves[event.key];
    if (next === undefined) return;
    event.preventDefault();
    select(next);
  }

  return (
    <div>
      <div
        role="tablist"
        aria-label={label}
        onKeyDown={onKeyDown}
        // Narrow screens scroll the row sideways; the right edge fades so it
        // is clear there are more tabs (and the end padding clears the fade).
        className="flex gap-1 overflow-x-auto border-b border-line max-md:pr-6 max-md:[mask-image:linear-gradient(to_right,#000_calc(100%-1.5rem),transparent)]"
      >
        {items.map((item) => {
          const isSelected = item.id === selected.id;
          return (
            <button
              key={item.id}
              ref={(el) => {
                if (el) tabRefs.current.set(item.id, el);
                else tabRefs.current.delete(item.id);
              }}
              type="button"
              role="tab"
              id={tabId(item.id)}
              aria-selected={isSelected}
              aria-controls={isSelected ? panelId(item.id) : undefined}
              tabIndex={isSelected ? 0 : -1}
              onClick={() => setSelectedId(item.id)}
              className={
                // The focus ring sits inside the tab: the scrolling row would clip one outside it.
                "-mb-px inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap border-b-2 px-3 py-2 text-sm font-medium focus-visible:-outline-offset-2 " +
                (isSelected ? "border-accent text-ink" : "border-transparent text-muted hover:text-ink")
              }
            >
              {item.label}
              {item.count !== undefined ? (
                <span className="rounded-full bg-surface-muted px-1.5 text-xs text-muted">{item.count}</span>
              ) : null}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={panelId(selected.id)} aria-labelledby={tabId(selected.id)} tabIndex={0} className="pt-4">
        {selected.render()}
      </div>
    </div>
  );
}
