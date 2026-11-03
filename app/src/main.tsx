import { Component, StrictMode, useEffect, useState, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App";
import type { Layout, Profile, Schema } from "./types";
import { setCpus } from "./hardware";
import { setRefRules } from "./refs";
import "./styles.css";

function Loader() {
  const [data, setData] = useState<{ schema: Schema; layout: Layout; profile: Profile } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    const get = (f: string) => fetch(`${import.meta.env.BASE_URL}data/${f}`).then((r) => { if (!r.ok) throw new Error(`${f}: ${r.status}`); return r.json(); });
    // the CPU catalog is optional data: without it the built-in list is used
    const cpus = get("cpus.json").then((j) => setCpus(j.cpus ?? [])).catch(() => undefined);
    const refs = get("reference_ranges.json").then((j) => setRefRules(j.rules ?? [], j.sanity ?? [])).catch(() => undefined);
    Promise.all([get("bios_schema.json"), get("layout.json"), get("hardware_profile.json"), cpus, refs])
      .then(([schema, layout, profile]) => setData({ schema, layout, profile }))
      .catch((e) => setErr(String(e)));
  }, []);
  if (err) return <div className="boot">Failed to load BIOS data: {err}<br />Run <code>python -m biosai bundle</code> first.</div>;
  if (!data) return <div className="boot">Loading BIOS…</div>;
  return <App {...data} />;
}

class Boundary extends Component<{ children: ReactNode }, { err: Error | null }> {
  state = { err: null as Error | null };
  static getDerivedStateFromError(err: Error) { return { err }; }
  render() {
    if (this.state.err) return <div className="boot"><div><b>Emulator crashed</b><pre>{this.state.err.stack}</pre></div></div>;
    return this.props.children;
  }
}

createRoot(document.getElementById("root")!).render(<StrictMode><Boundary><Loader /></Boundary></StrictMode>);
