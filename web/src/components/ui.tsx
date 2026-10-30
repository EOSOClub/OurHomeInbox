// The small building blocks every page shares: buttons, text fields, cards,
// notices, loading and error states, and a copy button.

import { Check, CircleAlert, Copy, Info, LoaderCircle, TriangleAlert } from "lucide-react";
import { useEffect, useId, useState, type ButtonHTMLAttributes, type InputHTMLAttributes, type ReactNode } from "react";
import { copyText } from "../clipboard";

function cx(...classes: Array<string | false | null | undefined>): string {
  return classes.filter(Boolean).join(" ");
}

type ButtonVariant = "primary" | "secondary" | "quiet";

const BUTTON_BASE =
  "inline-flex items-center justify-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-60";

const BUTTON_VARIANTS: Record<ButtonVariant, string> = {
  primary: "bg-accent text-on-accent hover:bg-accent-hover",
  secondary: "border border-line bg-surface text-ink hover:bg-surface-muted",
  quiet: "text-muted hover:bg-surface-muted hover:text-ink",
};

export function buttonClasses(variant: ButtonVariant = "secondary", extra?: string): string {
  return cx(BUTTON_BASE, BUTTON_VARIANTS[variant], extra);
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  busy?: boolean;
}

export function Button({ variant = "secondary", busy = false, className, children, disabled, type = "button", ...rest }: ButtonProps) {
  return (
    <button type={type} className={buttonClasses(variant, className)} disabled={disabled || busy} aria-busy={busy || undefined} {...rest}>
      {busy ? <LoaderCircle aria-hidden className="size-4 animate-spin" /> : null}
      {children}
    </button>
  );
}

interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "id"> {
  label: string;
  hint?: string;
  error?: string | null;
}

export function TextField({ label, hint: givenHint, error, className, ...rest }: TextFieldProps) {
  const id = useId();
  // An error takes the hint's place: the two usually say the same thing.
  const hint = error ? undefined : givenHint;
  const hintId = hint ? `${id}-hint` : undefined;
  const errorId = error ? `${id}-error` : undefined;
  const describedBy = [hintId, errorId].filter(Boolean).join(" ") || undefined;
  return (
    <div className={cx("flex flex-col gap-1", className)}>
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input
        id={id}
        aria-invalid={error ? true : undefined}
        aria-describedby={describedBy}
        className={cx(
          "w-full rounded-md border bg-surface px-3 py-2 text-base text-ink placeholder:text-muted",
          error ? "border-danger" : "border-line",
        )}
        {...rest}
      />
      {hint ? (
        <p id={hintId} className="text-sm text-muted">
          {hint}
        </p>
      ) : null}
      {error ? (
        <p id={errorId} className="text-sm text-danger">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function Card({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("rounded-lg border border-line bg-surface p-4 sm:p-5", className)}>{children}</section>;
}

type NoticeTone = "info" | "warning" | "error";

const NOTICE_TONES: Record<NoticeTone, string> = {
  info: "border-line bg-surface-muted text-ink",
  warning: "border-warn-line bg-warn-soft text-warn",
  error: "border-danger-line bg-danger-soft text-danger",
};

const NOTICE_ICONS = { info: Info, warning: TriangleAlert, error: CircleAlert } as const;

export function Notice({ tone = "info", children, className, live = false }: { tone?: NoticeTone; children: ReactNode; className?: string; live?: boolean }) {
  const Icon = NOTICE_ICONS[tone];
  return (
    <div role={live ? (tone === "error" ? "alert" : "status") : undefined} className={cx("flex items-start gap-2 rounded-md border px-3 py-2 text-sm", NOTICE_TONES[tone], className)}>
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <div className="min-w-0">{children}</div>
    </div>
  );
}

export function LoadingState({ label = "Loading" }: { label?: string }) {
  return (
    <div role="status" className="flex items-center gap-2 py-8 text-muted">
      <LoaderCircle aria-hidden className="size-5 animate-spin" />
      <span>{label}...</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : "Something went wrong. Please try again.";
  return (
    <Notice tone="error" live className="my-4">
      <p>{message}</p>
      {onRetry ? (
        <Button variant="secondary" className="mt-2" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </Notice>
  );
}

/** A button that copies `text`, then says whether it worked. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");

  useEffect(() => {
    if (state === "idle") return;
    const timer = window.setTimeout(() => setState("idle"), 2500);
    return () => window.clearTimeout(timer);
  }, [state]);

  async function onCopy() {
    setState((await copyText(text)) ? "copied" : "failed");
  }

  return (
    <span className="inline-flex items-center gap-2">
      <Button variant="secondary" className="px-3 py-1" onClick={onCopy} aria-label={label}>
        {state === "copied" ? <Check aria-hidden className="size-4" /> : <Copy aria-hidden className="size-4" />}
        {state === "copied" ? "Copied" : "Copy"}
      </Button>
      <span role="status" className="text-sm text-muted">
        {state === "failed" ? "Copy did not work. Select the text and copy it yourself." : ""}
      </span>
    </span>
  );
}

/** A label and value row for detail lists (<dl>). */
export function DetailRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="py-2 sm:grid sm:grid-cols-[9rem_1fr] sm:gap-4">
      <dt className="text-sm text-muted">{label}</dt>
      <dd className="mt-0.5 min-w-0 wrap-anywhere sm:mt-0">{children}</dd>
    </div>
  );
}

export function PageTitle({ children, description }: { children: ReactNode; description?: ReactNode }) {
  return (
    <div className="mb-4">
      <h1 className="text-2xl font-semibold tracking-tight">{children}</h1>
      {description ? <p className="mt-1 text-muted">{description}</p> : null}
    </div>
  );
}
