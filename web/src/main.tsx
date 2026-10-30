// Starts the web app: data cache, router, styles, and what happens when the
// server says the person is no longer signed in.

import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import { setUnauthorizedHandler } from "./api";
import { App } from "./App";
import { createQueryClient, showSignedOut } from "./queries";
import "./styles.css";

const queryClient = createQueryClient();
setUnauthorizedHandler(() => showSignedOut(queryClient));

const root = document.getElementById("root");
if (!root) throw new Error("The page is missing its #root element.");

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <App />
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
