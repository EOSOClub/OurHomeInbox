// Shown for a page address the app does not know.

import { Link } from "react-router";
import { PageTitle } from "../components/ui";

export function NotFoundPage() {
  return (
    <div>
      <PageTitle description="There is no page at this address.">Page not found</PageTitle>
      <Link to="/" className="font-medium text-accent hover:underline">
        Go to captured mail
      </Link>
    </div>
  );
}
