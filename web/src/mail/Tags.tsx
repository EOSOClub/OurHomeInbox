// Tags as the pages show them: a tag chip (with a remove button when it can
// be taken off), a row of chips, and a box to add a tag by name, which
// suggests the household's tags and makes a new one for a new name.

import { Tag as TagIcon, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { TagRef } from "../../../src/shared/api";
import { normalizeTagName, tagKey, tagNameProblem } from "../../../src/shared/tags";
import { Button } from "../components/ui";

export function TagChip({ tag, onRemove, disabled = false }: { tag: TagRef; onRemove?: () => void; disabled?: boolean }) {
  return (
    <span className="inline-flex max-w-full min-w-0 items-center gap-1 rounded-full border border-line bg-accent-soft py-0.5 pr-1 pl-2 text-xs font-medium text-ink">
      <TagIcon aria-hidden className="size-3 shrink-0 text-accent" />
      <span className="truncate">{tag.name}</span>
      {onRemove ? (
        <button
          type="button"
          onClick={onRemove}
          disabled={disabled}
          aria-label={`Remove the tag ${tag.name}`}
          className="-my-0.5 rounded-full p-0.5 text-muted hover:bg-surface hover:text-ink disabled:opacity-60"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      ) : (
        // Keeps a chip without a button as wide on the right as one with it.
        <span aria-hidden className="w-1" />
      )}
    </span>
  );
}

/** The tags, as a row of chips that wraps. Nothing when there are none. */
export function TagChips({ tags, className = "" }: { tags: readonly TagRef[]; className?: string }) {
  if (tags.length === 0) return null;
  return (
    <ul aria-label="Tags" className={`flex min-w-0 flex-wrap gap-1 ${className}`}>
      {tags.map((tag) => (
        <li key={tag.id} className="min-w-0 max-w-full">
          <TagChip tag={tag} />
        </li>
      ))}
    </ul>
  );
}

/**
 * A box to type a tag's name, suggesting the household's tags (`known`)
 * except those in `exclude`, and an Add button. `onAdd` gets the tidied name
 * and resolves true when it worked, which empties the box and keeps the
 * cursor in it for the next tag. With `onCancel`, Escape, Cancel or a click
 * anywhere outside the box ends adding.
 */
export function TagAdder({
  known,
  exclude = [],
  onAdd,
  busy,
  label,
  buttonLabel = "Add",
  autoFocus = false,
  onCancel,
}: {
  known: readonly TagRef[];
  exclude?: readonly TagRef[];
  onAdd: (name: string) => Promise<boolean>;
  busy: boolean;
  label: string;
  buttonLabel?: string;
  autoFocus?: boolean;
  onCancel?: () => void;
}) {
  const id = useId();
  const formRef = useRef<HTMLFormElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [problem, setProblem] = useState<string | null>(null);
  const excluded = new Set(exclude.map((tag) => tag.id));

  // A click or tap anywhere outside the box ends adding. The suggestion list
  // is drawn by the browser, not the page, so picking from it does not count.
  useEffect(() => {
    if (!onCancel) return;
    const cancel = onCancel;
    function onPointerDown(event: PointerEvent) {
      const form = formRef.current;
      if (form && event.target instanceof Node && !form.contains(event.target)) cancel();
    }
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [onCancel]);
  const suggestions = known.filter((tag) => !excluded.has(tag.id));

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = normalizeTagName(text);
    const found = tagNameProblem(name);
    if (found) {
      setProblem(found);
      return;
    }
    if (exclude.some((tag) => tagKey(tag.name) === tagKey(name))) {
      setProblem(`It already has the tag ${exclude.find((tag) => tagKey(tag.name) === tagKey(name))!.name}.`);
      return;
    }
    setProblem(null);
    if (await onAdd(name)) setText("");
    // Ready for the next tag, also after clicking Add instead of pressing Enter.
    inputRef.current?.focus();
  }

  return (
    <form ref={formRef} onSubmit={(e) => void submit(e)} className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          list={`${id}-known`}
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && onCancel) onCancel();
          }}
          placeholder="Tag name"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          className={
            "w-44 min-w-0 flex-1 rounded-md border bg-surface px-3 py-1.5 text-base text-ink placeholder:text-muted sm:flex-none sm:text-sm " +
            (problem ? "border-danger" : "border-line")
          }
        />
        <datalist id={`${id}-known`}>
          {suggestions.map((tag) => (
            <option key={tag.id} value={tag.name} />
          ))}
        </datalist>
        <Button type="submit" variant="secondary" className="px-3 py-1.5" busy={busy}>
          {buttonLabel}
        </Button>
        {onCancel ? (
          <Button variant="quiet" className="px-3 py-1.5" onClick={onCancel}>
            Cancel
          </Button>
        ) : null}
      </div>
      {problem ? (
        <p id={`${id}-problem`} className="text-sm text-danger">
          {problem}
        </p>
      ) : null}
    </form>
  );
}
