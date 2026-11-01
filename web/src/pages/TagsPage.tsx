// The household's tags, by name: add one, rename one, or delete one (it comes
// off every email, after a confirmation on the page). Each tag links to the
// captured-mail list showing only its emails.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Pencil, Tag as TagIcon, Trash2 } from "lucide-react";
import { useId, useState, type FormEvent } from "react";
import { Link } from "react-router";
import type { Tag } from "../../../src/shared/api";
import { MAX_TAG_NAME, normalizeTagName, tagNameProblem } from "../../../src/shared/tags";
import { api } from "../api";
import { Button, ErrorState, LoadingState, Notice, PageTitle } from "../components/ui";
import { plural } from "../format";
import { refreshAfterTagChange, useTags } from "../queries";

const SMALL = "px-3 py-1.5";

/** A name box and a button, for adding a tag or renaming one. `onSave` resolves true when it worked. */
function NameForm({
  label,
  initial = "",
  buttonLabel,
  busy,
  onSave,
  onCancel,
  autoFocus = false,
}: {
  label: string;
  initial?: string;
  buttonLabel: string;
  busy: boolean;
  onSave: (name: string) => Promise<boolean>;
  onCancel?: () => void;
  autoFocus?: boolean;
}) {
  const id = useId();
  const [text, setText] = useState(initial);
  const [problem, setProblem] = useState<string | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = normalizeTagName(text);
    const found = tagNameProblem(name);
    setProblem(found);
    if (found) return;
    if (await onSave(name)) setText("");
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex min-w-0 flex-col gap-1">
      <label htmlFor={id} className="sr-only">
        {label}
      </label>
      <div className="flex min-w-0 flex-wrap items-center gap-2">
        <input
          id={id}
          value={text}
          autoFocus={autoFocus}
          autoComplete="off"
          maxLength={MAX_TAG_NAME * 2}
          onChange={(e) => {
            setText(e.target.value);
            setProblem(null);
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape" && onCancel) onCancel();
          }}
          placeholder="Tag name, like Utilities"
          aria-invalid={problem ? true : undefined}
          aria-describedby={problem ? `${id}-problem` : undefined}
          className={"w-56 min-w-0 flex-1 rounded-md border bg-surface px-3 py-1.5 text-base text-ink placeholder:text-muted sm:flex-none " + (problem ? "border-danger" : "border-line")}
        />
        <Button type="submit" variant="primary" className={SMALL} busy={busy}>
          {buttonLabel}
        </Button>
        {onCancel ? (
          <Button variant="quiet" className={SMALL} onClick={onCancel}>
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

function TagRow({ tag }: { tag: Tag }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<"view" | "rename" | "delete">("view");
  const rename = useMutation({
    mutationFn: (name: string) => api.renameTag(tag.id, { name }),
    onSuccess: () => refreshAfterTagChange(queryClient),
  });
  const remove = useMutation({
    mutationFn: () => api.deleteTag(tag.id),
    onSuccess: () => refreshAfterTagChange(queryClient),
  });

  async function save(name: string): Promise<boolean> {
    try {
      await rename.mutateAsync(name);
      setMode("view");
      return true;
    } catch {
      return false; // shown below from rename.error
    }
  }

  const emails = plural(tag.emails, "email", "emails");
  return (
    <li className="rounded-lg border border-line bg-surface p-3 sm:px-4">
      {mode === "rename" ? (
        <NameForm label={`New name for ${tag.name}`} initial={tag.name} buttonLabel="Save" busy={rename.isPending} onSave={save} onCancel={() => setMode("view")} autoFocus />
      ) : (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
          <div className="flex min-w-0 items-center gap-2">
            <TagIcon aria-hidden className="size-4 shrink-0 text-accent" />
            <span className="min-w-0 truncate font-medium">{tag.name}</span>
            {tag.emails > 0 ? (
              <Link to={`/?tag=${tag.id}`} className="shrink-0 text-sm font-medium text-accent hover:underline">
                {emails}
              </Link>
            ) : (
              <span className="shrink-0 text-sm text-muted">No emails</span>
            )}
          </div>
          {mode === "view" ? (
            <div className="flex gap-1">
              <Button
                variant="quiet"
                className="px-2 py-1"
                aria-label={`Rename ${tag.name}`}
                onClick={() => {
                  rename.reset();
                  setMode("rename");
                }}
              >
                <Pencil aria-hidden className="size-4" />
                Rename
              </Button>
              <Button
                variant="quiet"
                className="px-2 py-1"
                aria-label={`Delete ${tag.name}`}
                onClick={() => {
                  remove.reset();
                  setMode("delete");
                }}
              >
                <Trash2 aria-hidden className="size-4" />
                Delete
              </Button>
            </div>
          ) : null}
        </div>
      )}
      {mode === "delete" ? (
        <div role="group" aria-label={`Delete ${tag.name}?`} className="mt-3 flex flex-wrap items-center gap-2 border-t border-line pt-3">
          <p className="text-sm">
            Delete {tag.name}? {tag.emails > 0 ? `It comes off ${emails}. The emails stay.` : "No email has it."}
          </p>
          <Button variant="danger" className={SMALL} busy={remove.isPending} onClick={() => remove.mutate()}>
            Delete
          </Button>
          <Button variant="quiet" className={SMALL} onClick={() => setMode("view")}>
            Cancel
          </Button>
        </div>
      ) : null}
      {rename.isError ? (
        <Notice tone="error" live className="mt-2">
          Could not rename it: {rename.error.message}
        </Notice>
      ) : null}
      {remove.isError ? (
        <Notice tone="error" live className="mt-2">
          Could not delete it: {remove.error.message}
        </Notice>
      ) : null}
    </li>
  );
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-muted">
      <TagIcon aria-hidden className="mx-auto mb-2 size-8" />
      <p>No tags yet.</p>
      <p className="mt-1">Add one here, or from any captured email.</p>
    </div>
  );
}

export function TagsPage() {
  const queryClient = useQueryClient();
  const tags = useTags();
  const all = tags.data?.tags;
  const create = useMutation({
    mutationFn: (name: string) => api.createTag({ name }),
    onSuccess: () => refreshAfterTagChange(queryClient),
  });

  async function add(name: string): Promise<boolean> {
    try {
      await create.mutateAsync(name);
      return true;
    } catch {
      return false; // shown below from create.error
    }
  }

  return (
    <div>
      <PageTitle description="Your own labels for emails, like Utilities or Taxes 2026. Tag an email on its page, or select several in Captured mail.">
        Tags
      </PageTitle>
      <div className="mb-4 flex flex-col gap-2">
        <NameForm label="New tag name" buttonLabel="Add a tag" busy={create.isPending} onSave={add} />
        {create.isError ? (
          <Notice tone="error" live>
            Could not add it: {create.error.message}
          </Notice>
        ) : null}
      </div>
      {tags.isPending ? <LoadingState label="Loading tags" /> : null}
      {tags.isError ? <ErrorState error={tags.error} onRetry={() => void tags.refetch()} /> : null}
      {all && all.length === 0 ? <EmptyState /> : null}
      {all && all.length > 0 ? (
        <>
          <p className="mb-3 text-sm text-muted">{plural(all.length, "tag", "tags")}</p>
          <ul className="flex flex-col gap-2">
            {all.map((tag) => (
              <TagRow key={tag.id} tag={tag} />
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
