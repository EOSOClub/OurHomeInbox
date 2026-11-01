// The tags on one email, on its page: each with a button to take it off, and
// "Add a tag", which opens a box suggesting the household's tags (a new name
// makes a new tag). The box stays open after each tag for the next one; a
// click outside it, Escape or Cancel closes it.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { useState } from "react";
import type { CaptureDetailResponse, CaptureTagsRequest } from "../../../src/shared/api";
import { api } from "../api";
import { Button, Notice } from "../components/ui";
import { queryKeys, refreshAfterTagChange, useTags } from "../queries";
import { TagAdder, TagChip } from "./Tags";

export function CaptureTagEditor({ detail }: { detail: CaptureDetailResponse }) {
  const queryClient = useQueryClient();
  const known = useTags().data?.tags ?? [];
  const [adding, setAdding] = useState(false);
  const change = useMutation({
    mutationFn: (body: Omit<CaptureTagsRequest, "captureIds">) => api.changeCaptureTags({ captureIds: [detail.id], ...body }),
    onSuccess: (result) => {
      // Shown at once; the refresh brings the list and the tag counts up to date.
      const tags = result.captures.find((c) => c.id === detail.id)?.tags;
      if (tags) {
        queryClient.setQueryData<CaptureDetailResponse>(queryKeys.capture(detail.id), (old) => (old ? { ...old, tags } : old));
      }
      refreshAfterTagChange(queryClient);
    },
  });

  async function add(name: string): Promise<boolean> {
    try {
      await change.mutateAsync({ add: [name] });
      return true;
    } catch {
      return false; // shown below from change.error
    }
  }

  return (
    <div className="flex min-w-0 flex-col gap-2">
      <div className="flex min-w-0 flex-wrap items-center gap-1">
        {detail.tags.length === 0 && !adding ? <span className="mr-1 text-muted">None</span> : null}
        {detail.tags.map((tag) => (
          <TagChip key={tag.id} tag={tag} disabled={change.isPending} onRemove={() => change.mutate({ remove: [tag.id] })} />
        ))}
        {adding ? null : (
          <Button
            variant="quiet"
            className="px-2 py-0.5"
            onClick={() => {
              change.reset();
              setAdding(true);
            }}
          >
            <Plus aria-hidden className="size-4" />
            Add a tag
          </Button>
        )}
      </div>
      {adding ? (
        <TagAdder
          known={known}
          exclude={detail.tags}
          onAdd={add}
          busy={change.isPending}
          label="Tag to add to this email"
          autoFocus
          onCancel={() => setAdding(false)}
        />
      ) : null}
      {change.isError ? (
        <Notice tone="error" live>
          Could not change the tags: {change.error.message}
        </Notice>
      ) : null}
    </div>
  );
}
