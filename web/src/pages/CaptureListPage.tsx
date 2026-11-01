// The list of captured mail, newest first, with each email's biller, its tags
// and what the reader picked out of it, a search box, buttons to show only
// emails with or without a biller, a choice of tag, and behind "Filters" the
// kind of email, a range of days and ticks for "Needs a check", "Past due"
// and "Sender not verified" (all in the browser; the search and every filter
// are in the page address, so Back from an email or a link opens the list the
// same way). Each row opens that email. Select turns the rows into
// checkboxes, to add a tag to several emails at once or take one off.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { CheckSquare, Inbox, Link2, Paperclip, ReceiptText, Search, SlidersHorizontal, Tags } from "lucide-react";
import { useId, useMemo, useState, type ReactNode } from "react";
import { Link, useLocation, useSearchParams } from "react-router";
import type { CaptureListItem, CaptureListResponse, CaptureTagsRequest, Tag, TagRef } from "../../../src/shared/api";
import { EMAIL_KINDS } from "../../../src/shared/extraction";
import { MAX_TAGGED_AT_ONCE } from "../../../src/shared/tags";
import { api, capturePagePath } from "../api";
import { Button, ErrorState, LoadingState, Notice, PageTitle } from "../components/ui";
import { formatDateTime, formatListDate, plural, senderDisplay, subjectDisplay } from "../format";
import {
  captureDate,
  filterCaptures,
  filtersFrom,
  isNarrowed,
  moreFiltersOn,
  withFilters,
  withoutFilters,
  type BillerFilter,
  type CaptureFilters,
  type FromList,
  type KindFilter,
  type TagFilter,
} from "../mail/captureList";
import { KIND_LABELS, summaryLine } from "../mail/picked";
import { TagAdder, TagChips } from "../mail/Tags";
import { queryKeys, refreshAfterTagChange, useCaptures, useMailboxes, useTags } from "../queries";

function Count({ icon, count, one, many }: { icon: ReactNode; count: number; one: string; many: string }) {
  return (
    <span className={"inline-flex items-center gap-1" + (count === 0 ? " opacity-60" : "")} title={plural(count, one, many)}>
      {icon}
      {count}
      <span className="sr-only">{count === 1 ? one : many}</span>
    </span>
  );
}

/** The email's kind and what the reader picked out, such as "Bill  $4.13, due Nov 4, 2026", and any doubt about it or its sender. */
function PickedLine({ picked, senderVerified }: { picked: CaptureListItem["picked"]; senderVerified: boolean }) {
  const line = summaryLine(picked);
  return (
    <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span className="rounded border border-line bg-surface-muted px-1.5 text-xs font-medium">{KIND_LABELS[picked.kind]}</span>
      {line ? <span className="font-medium">{line}</span> : <span className="text-muted">Nothing picked out</span>}
      {picked.needsCheck ? <span className="font-medium text-warn">Needs a check</span> : null}
      {senderVerified ? null : <span className="font-medium text-warn">Sender not verified</span>}
    </p>
  );
}

/** What a row shows of an email. */
function RowContent({ item }: { item: CaptureListItem }) {
  const when = captureDate(item);
  return (
    <>
      <div className="flex items-baseline justify-between gap-3">
        <span className="min-w-0 truncate font-medium">{senderDisplay(item.from)}</span>
        <time dateTime={when} title={formatDateTime(when)} className="shrink-0 text-sm text-muted">
          {formatListDate(when)}
        </time>
      </div>
      <p className="mt-0.5 truncate">{subjectDisplay(item.subject)}</p>
      <PickedLine picked={item.picked} senderVerified={item.senderVerified} />
      <TagChips tags={item.tags} className="mt-2" />
      <div className="mt-2 flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted">
        {item.biller ? (
          <span className="inline-flex min-w-0 items-center gap-1 font-medium text-accent">
            <ReceiptText aria-hidden className="size-3.5 shrink-0" />
            <span className="sr-only">Biller: </span>
            <span className="truncate">{item.biller.name}</span>
          </span>
        ) : (
          <span className="inline-flex items-center gap-1">
            <ReceiptText aria-hidden className="size-3.5 shrink-0 opacity-60" />
            No biller
          </span>
        )}
        <span className="inline-flex min-w-0 items-center gap-1">
          <Inbox aria-hidden className="size-3.5 shrink-0" />
          <span className="truncate">{item.mailbox}</span>
        </span>
        <Count icon={<Paperclip aria-hidden className="size-3.5" />} count={item.attachmentCount} one="attachment" many="attachments" />
        <Count icon={<Link2 aria-hidden className="size-3.5" />} count={item.linkCount} one="link" many="links" />
      </div>
    </>
  );
}

/** A row that opens the email; `fromList` lets its "Back to captured mail" return to the list with the same search and filters. */
function CaptureRow({ item, fromList }: { item: CaptureListItem; fromList: FromList }) {
  return (
    <li>
      <Link to={capturePagePath(item.id)} state={fromList} className="block rounded-lg border border-line bg-surface p-3 hover:bg-surface-muted sm:px-4">
        <RowContent item={item} />
      </Link>
    </li>
  );
}

/** A row while selecting: a checkbox, and the rest of the row ticks it too. */
function SelectableRow({ item, selected, onToggle }: { item: CaptureListItem; selected: boolean; onToggle: () => void }) {
  return (
    <li
      className={
        "flex items-start gap-3 rounded-lg border p-3 sm:px-4 " + (selected ? "border-accent bg-accent-soft" : "border-line bg-surface hover:bg-surface-muted")
      }
    >
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select: ${subjectDisplay(item.subject)}, from ${senderDisplay(item.from)}`}
        className="mt-1 size-4 shrink-0 accent-accent"
      />
      {/* The checkbox is the control for keyboards and screen readers; this is a bigger target for a pointer. */}
      <div className="min-w-0 flex-1 cursor-pointer" onClick={onToggle}>
        <RowContent item={item} />
      </div>
    </li>
  );
}

/** The list's tag filter: any tag, no tags, or one tag (with how many emails carry it). */
function TagFilterSelect({ tags, value, onChange }: { tags: readonly Tag[]; value: TagFilter; onChange: (value: string) => void }) {
  const id = useId();
  return (
    <div className="flex min-w-0 items-center gap-2">
      <label htmlFor={id} className="text-sm text-muted">
        Tag
      </label>
      <select
        id={id}
        value={String(value)}
        onChange={(e) => onChange(e.target.value)}
        className="min-w-0 max-w-full rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink"
      >
        <option value="all">Any</option>
        <option value="none">No tags</option>
        {tags.map((tag) => (
          <option key={tag.id} value={String(tag.id)}>
            {tag.name} ({tag.emails})
          </option>
        ))}
      </select>
    </div>
  );
}

/** The tags any of `items` carry, by name, each once. */
function tagsAmong(items: readonly CaptureListItem[]): TagRef[] {
  const byId = new Map<number, TagRef>();
  for (const item of items) for (const tag of item.tags) byId.set(tag.id, tag);
  return [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}

/** While selecting: how many are selected, select all or none, add a tag to them or take one off, and Done. */
function SelectionBar({
  all,
  shown,
  selected,
  setSelected,
  known,
  onDone,
}: {
  all: readonly CaptureListItem[];
  shown: readonly CaptureListItem[];
  selected: ReadonlySet<string>;
  setSelected: (ids: Set<string>) => void;
  known: readonly TagRef[];
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const removeId = useId();
  const [toRemove, setToRemove] = useState("");
  const [done, setDone] = useState<string | null>(null);
  const change = useMutation({
    mutationFn: (body: CaptureTagsRequest) => api.changeCaptureTags(body),
    onSuccess: (result) => {
      // The rows show their new tags with the message, not a moment later when the list reloads.
      const tagsNow = new Map(result.captures.map((c) => [c.id, c.tags]));
      queryClient.setQueryData<CaptureListResponse>(queryKeys.captures, (old) =>
        old ? { captures: old.captures.map((item) => (tagsNow.has(item.id) ? { ...item, tags: tagsNow.get(item.id)! } : item)) } : old,
      );
      refreshAfterTagChange(queryClient);
    },
  });

  const chosen = all.filter((item) => selected.has(item.id));
  const shownIds = new Set(shown.map((item) => item.id));
  const hidden = chosen.filter((item) => !shownIds.has(item.id)).length;
  const onChosen = tagsAmong(chosen);
  const tooMany = chosen.length > MAX_TAGGED_AT_ONCE;
  const canAct = chosen.length > 0 && !tooMany;
  const emails = plural(chosen.length, "email", "emails");

  async function add(name: string): Promise<boolean> {
    if (!canAct) return false;
    setDone(null);
    try {
      await change.mutateAsync({ captureIds: chosen.map((item) => item.id), add: [name] });
      setDone(`Added ${name} to ${emails}.`);
      return true;
    } catch {
      return false; // shown below from change.error
    }
  }

  async function remove() {
    const tag = onChosen.find((t) => String(t.id) === toRemove);
    if (!canAct || !tag) return;
    setDone(null);
    const carrying = chosen.filter((item) => item.tags.some((t) => t.id === tag.id)).length;
    try {
      await change.mutateAsync({ captureIds: chosen.map((item) => item.id), remove: [tag.id] });
      setDone(`Took ${tag.name} off ${plural(carrying, "email", "emails")}.`);
      setToRemove("");
    } catch {
      // shown below from change.error
    }
  }

  return (
    <section aria-label="Selected emails" className="sticky top-0 z-10 mb-3 flex flex-col gap-3 rounded-lg border border-accent bg-surface p-3 shadow-sm sm:px-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="text-sm font-medium">
          {chosen.length === 0 ? "None selected. Tick the emails to tag." : `${chosen.length} selected`}
          {hidden > 0 ? <span className="font-normal text-muted">, {hidden} not shown here</span> : null}
        </p>
        <div className="flex flex-wrap gap-2">
          <Button variant="quiet" className="px-2 py-1" onClick={() => setSelected(new Set([...selected, ...shown.map((item) => item.id)]))}>
            Select all shown
          </Button>
          <Button variant="quiet" className="px-2 py-1" disabled={selected.size === 0} onClick={() => setSelected(new Set())}>
            Clear
          </Button>
          <Button variant="secondary" className="px-3 py-1" onClick={onDone}>
            Done
          </Button>
        </div>
      </div>
      {tooMany ? (
        <Notice tone="warning">Select at most {MAX_TAGGED_AT_ONCE} emails at once.</Notice>
      ) : null}
      {canAct ? (
        <div className="flex flex-wrap items-start gap-x-6 gap-y-3">
          <TagAdder known={known} onAdd={add} busy={change.isPending} label={`Tag to add to the ${emails}`} buttonLabel="Add tag" />
          {onChosen.length > 0 ? (
            <div className="flex min-w-0 flex-wrap items-center gap-2">
              <label htmlFor={removeId} className="sr-only">
                Tag to take off the {emails}
              </label>
              <select
                id={removeId}
                value={toRemove}
                onChange={(e) => setToRemove(e.target.value)}
                className="min-w-0 max-w-full rounded-md border border-line bg-surface px-2 py-1.5 text-sm text-ink"
              >
                <option value="">Take a tag off...</option>
                {onChosen.map((tag) => (
                  <option key={tag.id} value={String(tag.id)}>
                    {tag.name}
                  </option>
                ))}
              </select>
              <Button variant="secondary" className="px-3 py-1.5" disabled={toRemove === ""} busy={change.isPending} onClick={() => void remove()}>
                Remove
              </Button>
            </div>
          ) : null}
        </div>
      ) : null}
      {change.isError ? (
        <Notice tone="error" live>
          Could not change the tags: {change.error.message}
        </Notice>
      ) : null}
      {/* Always there, so a screen reader hears each new message. */}
      <p role="status" className={done && !change.isError ? "text-sm text-muted" : "sr-only"}>
        {change.isError ? "" : (done ?? "")}
      </p>
    </section>
  );
}

function EmptyState() {
  const mailboxes = useMailboxes();
  const data = mailboxes.data;
  const minutes = data?.checking.everyMinutes;
  const often = minutes ? (minutes === 1 ? "every minute" : `every ${minutes} minutes`) : "every few minutes";
  return (
    <div className="rounded-lg border border-dashed border-line px-4 py-10 text-center text-muted">
      <Inbox aria-hidden className="mx-auto mb-2 size-8" />
      {data && data.mailboxes.length === 0 ? (
        <p>
          No mailboxes are set up yet.{" "}
          <Link to="/settings" className="font-medium text-accent hover:underline">
            {data.canEdit ? "Add one in Settings." : "Ask an admin to add one in Settings."}
          </Link>
        </p>
      ) : (
        <p>No mail captured yet. OurHomeInbox reads each mailbox's bills folder {often}.</p>
      )}
    </div>
  );
}

const BILLER_FILTERS: ReadonlyArray<{ value: BillerFilter; label: string }> = [
  { value: "all", label: "All" },
  { value: "matched", label: "With a biller" },
  { value: "unmatched", label: "No biller" },
];

/** All / With a biller / No biller, as a row of toggle buttons. */
function BillerFilterButtons({ value, onChange }: { value: BillerFilter; onChange: (value: BillerFilter) => void }) {
  return (
    <div role="group" aria-label="Show" className="inline-flex rounded-md border border-line bg-surface p-0.5">
      {BILLER_FILTERS.map((filter) => (
        <button
          key={filter.value}
          type="button"
          aria-pressed={value === filter.value}
          onClick={() => onChange(filter.value)}
          className={
            "rounded px-3 py-1 text-sm font-medium " +
            (value === filter.value ? "bg-accent-soft text-ink" : "text-muted hover:text-ink")
          }
        >
          {filter.label}
        </button>
      ))}
    </div>
  );
}

/** Marks the page address changes the list makes itself, as against a link or the menu. */
const LIST_FILTERS = "captureListFilters";

/** A tick that narrows the list, such as "Past due". */
function FilterTick({ label, checked, onChange }: { label: string; checked: boolean; onChange: (checked: boolean) => void }) {
  return (
    <label className="inline-flex cursor-pointer items-center gap-2 text-sm">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-accent" />
      {label}
    </label>
  );
}

/** The filters behind the Filters button: the kind of email, a range of days, and the ticks. */
function MoreFilters({ id, filters, onChange }: { id: string; filters: CaptureFilters; onChange: (changes: Partial<CaptureFilters>) => void }) {
  const kindId = useId();
  const fromId = useId();
  const toId = useId();
  const backwards = filters.from !== "" && filters.to !== "" && filters.from > filters.to;
  const field = "rounded-md border border-line bg-surface px-2 py-1 text-sm text-ink";
  return (
    <section id={id} aria-label="More filters" className="mb-3 flex flex-col gap-3 rounded-lg border border-line bg-surface p-3 sm:px-4">
      <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
        <div className="flex items-center gap-2">
          <label htmlFor={kindId} className="w-10 text-sm text-muted sm:w-auto">
            Kind
          </label>
          <select id={kindId} value={filters.kind} onChange={(e) => onChange({ kind: e.target.value as KindFilter })} className={field}>
            <option value="all">Any</option>
            {EMAIL_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
        </div>
        {/* Each label stays with its box when the row wraps on a phone. */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-3">
          <div className="flex items-center gap-2">
            <label htmlFor={fromId} className="w-10 text-sm text-muted sm:w-auto">
              From
            </label>
            <input id={fromId} type="date" value={filters.from} onChange={(e) => onChange({ from: e.target.value })} className={field} />
          </div>
          <div className="flex items-center gap-2">
            <label htmlFor={toId} className="w-10 text-sm text-muted sm:w-auto">
              To
            </label>
            <input id={toId} type="date" value={filters.to} onChange={(e) => onChange({ to: e.target.value })} className={field} />
          </div>
        </div>
      </div>
      {backwards ? <p className="text-sm text-warn">The From day is after the To day, so nothing can match.</p> : null}
      <div className="flex flex-wrap gap-x-6 gap-y-2">
        <FilterTick label="Needs a check" checked={filters.needsCheck} onChange={(needsCheck) => onChange({ needsCheck })} />
        <FilterTick label="Past due" checked={filters.pastDue} onChange={(pastDue) => onChange({ pastDue })} />
        <FilterTick label="Sender not verified" checked={filters.unverified} onChange={(unverified) => onChange({ unverified })} />
      </div>
    </section>
  );
}

export function CaptureListPage() {
  const captures = useCaptures();
  const tags = useTags().data?.tags;
  const location = useLocation();
  const [searchParams, setSearchParams] = useSearchParams();
  // The search and filters, as a page address. Kept here and copied to the
  // address, because the router applies address changes in the background:
  // typing and ticks driven straight from the address would lag and drop keys.
  const [listSearch, setListSearch] = useState(() => searchParams.toString());
  // A new address from elsewhere (the menu, a link) replaces them; the page's
  // own copies are marked. Done while rendering, so the old ones never flash.
  const [seenKey, setSeenKey] = useState(location.key);
  if (location.key !== seenKey) {
    setSeenKey(location.key);
    if ((location.state as { by?: unknown } | null)?.by !== LIST_FILTERS) setListSearch(searchParams.toString());
  }
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const searchId = useId();
  const moreId = useId();
  const all = captures.data?.captures;
  const filters = filtersFrom(
    new URLSearchParams(listSearch),
    tags?.map((tag) => tag.id),
  );
  const fromList: FromList = { listSearch: listSearch ? `?${listSearch}` : "" };
  const { query, billers: billerFilter, tag: tagFilter, kind, from, to, needsCheck, pastDue, unverified } = filters;
  const moreOn = moreFiltersOn(filters);
  // Open at first when the address already asks for one of its filters.
  const [moreOpen, setMoreOpen] = useState(moreOn > 0);
  // By value: filters is a new object on every render.
  const shown = useMemo(
    () => (all ? filterCaptures(all, { query, billers: billerFilter, tag: tagFilter, kind, from, to, needsCheck, pastDue, unverified }) : []),
    [all, query, billerFilter, tagFilter, kind, from, to, needsCheck, pastDue, unverified],
  );
  const narrowed = isNarrowed(filters);
  const filteredTag = typeof tagFilter === "number" ? tags?.find((tag) => tag.id === tagFilter) : undefined;

  // Replaced, not pushed: Back leaves the list instead of undoing each keystroke or tick.
  function changeList(next: URLSearchParams) {
    setListSearch(next.toString());
    setSearchParams(next, { replace: true, state: { by: LIST_FILTERS } });
  }

  function setFilters(changes: Partial<CaptureFilters>) {
    changeList(withFilters(new URLSearchParams(listSearch), changes));
  }

  function clearFilters() {
    changeList(withoutFilters(new URLSearchParams(listSearch)));
  }

  function setTagFilter(value: string) {
    setFilters({ tag: value === "all" || value === "none" ? value : Number(value) });
  }

  function setBillerFilter(value: BillerFilter) {
    setFilters({ billers: value });
  }

  function toggle(id: string) {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  }

  function emptyMessage(): string {
    if (query.trim()) return `No captured mail matches "${query.trim()}"${billerFilter === "all" && tagFilter === "all" && moreOn === 0 ? "" : " here"}.`;
    if (moreOn > 0) return "No captured email matches these filters.";
    if (tagFilter === "none") return billerFilter === "all" ? "Every captured email has a tag." : "No email here is without a tag.";
    if (filteredTag) return billerFilter === "all" ? `No captured email has the tag ${filteredTag.name}.` : `No email here has the tag ${filteredTag.name}.`;
    return billerFilter === "matched" ? "No captured email has a biller yet." : "Every captured email has a biller.";
  }

  return (
    <div>
      <PageTitle>Captured mail</PageTitle>
      {captures.isPending ? <LoadingState label="Loading captured mail" /> : null}
      {captures.isError ? <ErrorState error={captures.error} onRetry={() => void captures.refetch()} /> : null}
      {all && all.length === 0 ? <EmptyState /> : null}
      {all && all.length > 0 ? (
        <>
          <div className="relative mb-3">
            <label htmlFor={searchId} className="sr-only">
              Search captured mail
            </label>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted" />
            <input
              id={searchId}
              type="search"
              value={query}
              onChange={(e) => setFilters({ query: e.target.value })}
              placeholder="Search subject, sender, biller or tag"
              className="w-full rounded-md border border-line bg-surface py-2 pr-3 pl-9 text-base placeholder:text-muted"
            />
          </div>
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
              <p role="status" className="text-sm text-muted">
                {narrowed ? `Showing ${shown.length} of ${plural(all.length, "email", "emails")}` : plural(all.length, "email", "emails")}
              </p>
              {narrowed ? (
                <button type="button" onClick={clearFilters} className="text-sm font-medium text-accent hover:underline">
                  Clear filters
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              {(tags && tags.length > 0) || tagFilter !== "all" ? <TagFilterSelect tags={tags ?? []} value={tagFilter} onChange={setTagFilter} /> : null}
              <BillerFilterButtons value={billerFilter} onChange={setBillerFilter} />
              <Button
                variant={moreOn > 0 ? "secondary" : "quiet"}
                className="px-3 py-1"
                aria-expanded={moreOpen}
                aria-controls={moreOpen ? moreId : undefined}
                onClick={() => setMoreOpen(!moreOpen)}
              >
                <SlidersHorizontal aria-hidden className="size-4" />
                Filters
                {moreOn > 0 ? <span className="rounded-full bg-accent px-1.5 text-xs text-on-accent">{moreOn}<span className="sr-only"> on</span></span> : null}
              </Button>
            </div>
          </div>
          {moreOpen ? <MoreFilters id={moreId} filters={filters} onChange={setFilters} /> : null}
          <div className="mb-3 flex flex-wrap items-center gap-2">
            {selecting ? null : (
              <Button variant="secondary" className="px-3 py-1" onClick={() => setSelecting(true)}>
                <CheckSquare aria-hidden className="size-4" />
                Select to tag
              </Button>
            )}
            <Link to="/tags" className="inline-flex items-center gap-1 px-1 text-sm font-medium text-accent hover:underline">
              <Tags aria-hidden className="size-4" />
              Manage tags
            </Link>
          </div>
          {selecting ? (
            <SelectionBar
              all={all}
              shown={shown}
              selected={selected}
              setSelected={setSelected}
              known={tags ?? []}
              onDone={() => {
                setSelecting(false);
                setSelected(new Set());
              }}
            />
          ) : null}
          {shown.length === 0 ? (
            <p className="py-6 text-center text-muted">{emptyMessage()}</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {shown.map((item) =>
                selecting ? (
                  <SelectableRow key={item.id} item={item} selected={selected.has(item.id)} onToggle={() => toggle(item.id)} />
                ) : (
                  <CaptureRow key={item.id} item={item} fromList={fromList} />
                ),
              )}
            </ul>
          )}
        </>
      ) : null}
    </div>
  );
}
