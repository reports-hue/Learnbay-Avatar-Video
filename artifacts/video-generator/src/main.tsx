import { createRoot } from "react-dom/client";
import App from "./App";
import { AuthGate } from "@/components/AuthGate";
import "./index.css";

createRoot(document.getElementById("root")!).render(
  <AuthGate>
    <App />
  </AuthGate>,
);
