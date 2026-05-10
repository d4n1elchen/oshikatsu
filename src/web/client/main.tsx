import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { AdminApp } from "./AdminApp";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

function getSurface(): "dashboard" | "admin" {
  return window.location.pathname.startsWith("/admin") ? "admin" : "dashboard";
}

function Router() {
  const [surface, setSurface] = useState(getSurface);

  useEffect(() => {
    const onPop = () => setSurface(getSurface());
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  return surface === "admin" ? <AdminApp /> : <App />;
}

createRoot(root).render(
  <React.StrictMode>
    <Router />
  </React.StrictMode>
);
