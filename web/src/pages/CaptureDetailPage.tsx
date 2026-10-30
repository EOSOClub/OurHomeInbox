// The page for one captured email: reads the email's address from the page
// URL, fetches it, and shows it with CaptureDetailView.

import { ArrowLeft } from "lucide-react";
import { Link, useParams } from "react-router";
import { ErrorState, LoadingState } from "../components/ui";
import { CaptureDetailView } from "../mail/CaptureDetailView";
import { useCapture } from "../queries";

export function CaptureDetailPage() {
  const { mailbox = "", uidValidity = "", uid = "" } = useParams();
  const capture = useCapture(`${mailbox}/${uidValidity}/${uid}`);

  return (
    <div>
      <Link to="/" className="mb-4 inline-flex items-center gap-1 text-sm font-medium text-accent hover:underline">
        <ArrowLeft aria-hidden className="size-4" />
        Back to captured mail
      </Link>
      {capture.isPending ? <LoadingState label="Loading this email" /> : null}
      {capture.isError ? <ErrorState error={capture.error} onRetry={() => void capture.refetch()} /> : null}
      {capture.data ? <CaptureDetailView detail={capture.data} /> : null}
    </div>
  );
}
