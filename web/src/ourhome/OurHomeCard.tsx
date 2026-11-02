// Settings' OurHome connection: the token OurHome uses to pick up the bills
// (made here, shown once, pasted into OurHome), the start date (emails dated
// before it are never sent, so nothing Paperless already brought in comes
// twice), and what OurHome has picked up. A new token replaces the old one;
// Disconnect stops the token working. The vault's "Hand-off" note has the rest.

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Copy, KeyRound } from "lucide-react";
import { useState, type FormEvent } from "react";
import type { OurHomeConnection } from "../../../src/shared/handoff";
import { api } from "../api";
import { Button, Card, DetailRow, ErrorState, LoadingState, Notice, TextField } from "../components/ui";
import { formatDateTime, plural } from "../format";
import { localDay } from "../mail/captureList";
import { formatDay } from "../mail/picked";
import { queryKeys, refreshAfterOurHomeChange, useOurHome } from "../queries";

const today = () => localDay(new Date().toISOString());

/** The token just made, with Copy. It is never shown again. */
function NewToken({ token }: { token: string }) {
  const [copied, setCopied] = useState<"yes" | "no" | null>(null);
  async function copy() {
    try {
      await navigator.clipboard.writeText(token);
      setCopied("yes");
    } catch {
      setCopied("no");
    }
  }
  return (
    <Notice tone="info" className="mt-4">
      <p className="font-medium">The token for OurHome. It is shown only now:</p>
      <p className="mt-2 rounded border border-line bg-surface px-2 py-1.5 font-mono text-sm break-all">{token}</p>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <Button variant="secondary" className="px-3 py-1" onClick={() => void copy()}>
          <Copy aria-hidden className="size-4" />
          Copy token
        </Button>
        <span role="status" className="text-sm">
          {copied === "yes" ? "Copied." : copied === "no" ? "Could not copy: select it and copy it by hand." : ""}
        </span>
      </div>
      <p className="mt-2 text-sm">
        In OurHome, open Settings, add the OurHomeInbox connection, and paste it there with this install's address. If it is lost, make a new one here.
      </p>
    </Notice>
  );
}

function StartDateForm({ connection }: { connection: OurHomeConnection }) {
  const queryClient = useQueryClient();
  const [day, setDay] = useState(connection.startDate ?? today());
  const save = useMutation({
    mutationFn: () => api.updateOurHome({ startDate: day }),
    onSuccess: (fresh) => {
      queryClient.setQueryData(queryKeys.ourhome, fresh);
      refreshAfterOurHomeChange(queryClient);
    },
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }
  return (
    <form className="flex flex-col gap-2" onSubmit={submit} noValidate>
      <div className="flex flex-wrap items-end gap-2">
        <TextField label="Send emails dated from" type="date" value={day} onChange={(e) => setDay(e.target.value)} className="min-w-0" />
        <Button type="submit" variant="secondary" className="px-3 py-2" busy={save.isPending} disabled={day === connection.startDate || day === ""}>
          Save date
        </Button>
      </div>
      <p className="text-sm text-muted">Emails dated before this day never go to OurHome, so bills Paperless already brought in do not come twice.</p>
      {save.isError ? (
        <Notice tone="error" live>
          {save.error.message}
        </Notice>
      ) : null}
      {save.isSuccess ? (
        <p role="status" className="text-sm text-muted">
          Saved.
        </p>
      ) : null}
    </form>
  );
}

export function OurHomeCard() {
  const queryClient = useQueryClient();
  const ourhome = useOurHome();
  const [token, setToken] = useState<string | null>(null);
  const [firstDay, setFirstDay] = useState(today);
  const [confirm, setConfirm] = useState<"replace" | "disconnect" | null>(null);
  const make = useMutation({
    mutationFn: (startDate: string | undefined) => api.makeOurHomeToken({ startDate }),
    onSuccess: (result) => {
      setToken(result.token);
      setConfirm(null);
      queryClient.setQueryData(queryKeys.ourhome, result.connection);
      refreshAfterOurHomeChange(queryClient);
    },
  });
  const revoke = useMutation({
    mutationFn: api.revokeOurHomeToken,
    onSuccess: (fresh) => {
      setToken(null);
      setConfirm(null);
      queryClient.setQueryData(queryKeys.ourhome, fresh);
      refreshAfterOurHomeChange(queryClient);
    },
  });
  const data = ourhome.data;
  const problem = make.error ?? revoke.error;

  return (
    <Card>
      <h2 className="flex items-center gap-2 text-lg font-semibold">
        <KeyRound aria-hidden className="size-5 shrink-0" />
        OurHome connection
      </h2>
      <p className="mt-1 text-muted">
        OurHome picks up the bills and receipts found here. It asks with a token you make here and paste into OurHome. Each email's page says whether it goes.
      </p>
      {ourhome.isPending ? <LoadingState label="Loading the OurHome connection" /> : null}
      {ourhome.isError ? <ErrorState error={ourhome.error} onRetry={() => void ourhome.refetch()} /> : null}
      {token ? <NewToken token={token} /> : null}
      {problem ? (
        <Notice tone="error" live className="mt-3">
          {problem.message}
        </Notice>
      ) : null}
      {data && !data.connected ? (
        <form
          className="mt-4 flex flex-col gap-3"
          onSubmit={(e) => {
            e.preventDefault();
            make.mutate(data.startDate ? undefined : firstDay);
          }}
          noValidate
        >
          <p className="font-medium">{data.startDate ? "Not connected: the token was turned off." : "Not connected yet."}</p>
          {data.startDate ? (
            <p className="text-sm text-muted">A new token keeps the start date, {formatDay(data.startDate)}.</p>
          ) : (
            <TextField
              label="Send emails dated from"
              type="date"
              value={firstDay}
              onChange={(e) => setFirstDay(e.target.value)}
              hint="Emails dated before this day never go to OurHome, so bills Paperless already brought in do not come twice. Today is usual."
            />
          )}
          <div>
            <Button type="submit" variant="primary" busy={make.isPending} disabled={!data.startDate && firstDay === ""}>
              Make a token for OurHome
            </Button>
          </div>
        </form>
      ) : null}
      {data?.connected ? (
        <>
          <dl className="mt-3 divide-y divide-line">
            <DetailRow label="Token">
              Made {formatDateTime(data.tokenCreatedAt)}
              {data.tokenCreatedBy ? ` by ${data.tokenCreatedBy}` : ""}
            </DetailRow>
            <DetailRow label="OurHome last asked">{data.lastUsedAt ? formatDateTime(data.lastUsedAt) : "Not yet"}</DetailRow>
            <DetailRow label="Picked up">
              {data.newest === 0
                ? "Nothing offered yet."
                : data.takenUpTo >= data.newest
                  ? `Everything offered so far (${plural(data.newest, "offer", "offers")}).`
                  : `${data.takenUpTo} of ${plural(data.newest, "offer", "offers")}; OurHome takes the rest the next time it asks.`}
            </DetailRow>
          </dl>
          <div className="mt-4">
            <StartDateForm key={data.startDate ?? ""} connection={data} />
          </div>
          {confirm === null ? (
            <div className="mt-4 flex flex-wrap gap-2">
              <Button variant="secondary" className="px-3 py-1.5" onClick={() => setConfirm("replace")}>
                Make a new token
              </Button>
              <Button variant="quiet" className="px-3 py-1.5" onClick={() => setConfirm("disconnect")}>
                Disconnect
              </Button>
            </div>
          ) : (
            <div role="group" aria-label={confirm === "replace" ? "Make a new token?" : "Disconnect OurHome?"} className="mt-4 flex flex-col gap-3 rounded-lg border border-line p-3">
              <p className="text-sm">
                {confirm === "replace"
                  ? "The token OurHome has now stops working at once. Paste the new one into OurHome."
                  : "The token stops working, so OurHome picks up nothing more. What it already has stays there."}
              </p>
              <div className="flex flex-wrap gap-2">
                {confirm === "replace" ? (
                  <Button variant="primary" busy={make.isPending} onClick={() => make.mutate(undefined)}>
                    Make a new token
                  </Button>
                ) : (
                  <Button variant="danger" busy={revoke.isPending} onClick={() => revoke.mutate()}>
                    Disconnect
                  </Button>
                )}
                <Button variant="quiet" onClick={() => setConfirm(null)}>
                  Cancel
                </Button>
              </div>
            </div>
          )}
        </>
      ) : null}
    </Card>
  );
}
