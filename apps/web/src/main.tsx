import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  NavLink,
  Route,
  Routes,
  useNavigate,
  useParams,
} from "react-router-dom";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type {
  Generation,
  RuntimeStatus,
  CreditWallet,
  Me,
} from "@video-lab/contracts";
import LongFormStoryboardStudio from "./LongFormStoryboardStudio.js";
import "./style.css";
const API = import.meta.env.VITE_API_BASE_URL ?? "/api";
const DEMO_GENERATIONS_KEY = "vl_demo_generations";
const token = () => localStorage.getItem("vl_token") || "demo-user";

type GenerationRequest = {
  prompt: string;
  settings: Generation["settings"];
};

type RuntimeConnectResponse = RuntimeStatus & {
  baseUrl: string;
  health?: { ok: boolean; provider: string; message?: string };
};

function nowIso() {
  return new Date().toISOString();
}

function readDemoGenerations() {
  try {
    return JSON.parse(
      localStorage.getItem(DEMO_GENERATIONS_KEY) ?? "[]",
    ) as Generation[];
  } catch {
    return [];
  }
}

function writeDemoGenerations(items: Generation[]) {
  localStorage.setItem(DEMO_GENERATIONS_KEY, JSON.stringify(items));
}

function demoGenerationStatus(generation: Generation): Generation {
  if (["completed", "failed", "cancelled"].includes(generation.status)) {
    return generation;
  }

  const age = Date.now() - new Date(generation.createdAt).getTime();
  const status: Generation["status"] =
    age < 1200
      ? "preparing"
      : age < 3000
        ? "generating"
        : age < 4200
          ? "uploading"
          : "completed";

  const updated: Generation = {
    ...generation,
    status,
    updatedAt: nowIso(),
  };

  if (status === "completed") {
    updated.output = {
      downloadUrl: "#",
      durationSeconds: generation.settings.durationSeconds,
    };
  } else if (generation.output) {
    updated.output = generation.output;
  }

  return updated;
}

function demoCreditCost(settings: Generation["settings"]) {
  const qualityMultiplier = { draft: 1, standard: 2, high: 3 }[
    settings.quality
  ];
  return Math.ceil((settings.durationSeconds / 4) * qualityMultiplier);
}

async function demoApi<T>(path: string, init: RequestInit = {}) {
  const method = init.method ?? "GET";
  const generations = readDemoGenerations().map(demoGenerationStatus);
  writeDemoGenerations(generations);

  if (path === "/v1/me") {
    return {
      uid: token(),
      email: `${token()}@example.test`,
      status: "active",
      roles: token() === "admin-token" ? ["admin"] : [],
      termsVersion: "2026-07",
      trialGrantedAt: nowIso(),
    } as T;
  }

  if (path === "/v1/credits") {
    const spent = generations
      .filter((g) => g.status === "completed")
      .reduce((sum, g) => sum + g.creditCost, 0);
    const reserved = generations
      .filter((g) =>
        ["queued", "preparing", "generating", "uploading"].includes(g.status),
      )
      .reduce((sum, g) => sum + g.creditCost, 0);

    return {
      uid: token(),
      available: Math.max(0, 12 - spent - reserved),
      reserved,
      spent,
      updatedAt: nowIso(),
      version: generations.length + 1,
    } as T;
  }

  if (path === "/v1/runtime/status") {
    return {
      provider: "browser-demo",
      status: "healthy",
      acceptingSubmissions: true,
      killSwitch: false,
      lastHeartbeatAt: nowIso(),
      queueDepth: generations.filter((g) =>
        ["queued", "preparing", "generating", "uploading"].includes(g.status),
      ).length,
      updatedAt: nowIso(),
    } as T;
  }

  if (path === "/v1/gallery") {
    return {
      items: generations.sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    } as T;
  }

  if (path === "/v1/generations" && method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}")) as GenerationRequest;
    const generation: Generation = {
      id: `demo_${crypto.randomUUID()}`,
      prompt: body.prompt,
      settings: body.settings,
      status: "queued",
      queuePosition: 1,
      creditCost: demoCreditCost(body.settings),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    writeDemoGenerations([generation, ...generations]);
    return generation as T;
  }

  const generationMatch = path.match(/^\/v1\/generations\/([^/]+)$/);
  if (generationMatch) {
    const generation = generations.find((g) => g.id === generationMatch[1]);
    if (!generation) throw new Error("Generation not found");
    return generation as T;
  }

  const cancelMatch = path.match(/^\/v1\/generations\/([^/]+)\/cancel$/);
  if (cancelMatch && method === "POST") {
    const updated = generations.map((g) =>
      g.id === cancelMatch[1]
        ? {
            ...g,
            status: "cancelled" as const,
            updatedAt: nowIso(),
            safeErrorMessage: "Cancelled by user",
          }
        : g,
    );
    writeDemoGenerations(updated);
    const generation = updated.find((g) => g.id === cancelMatch[1]);
    if (!generation) throw new Error("Generation not found");
    return generation as T;
  }

  if (path === "/v1/dev/process-one" && method === "POST") {
    const updated = generations.map((g, index) =>
      index === 0 && g.status !== "completed"
        ? {
            ...g,
            status: "completed" as const,
            updatedAt: nowIso(),
            output: {
              downloadUrl: "#",
              durationSeconds: g.settings.durationSeconds,
            },
          }
        : g,
    );
    writeDemoGenerations(updated);
    return { ok: true } as T;
  }

  if (path === "/v1/admin/runtime/connect" && method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}")) as { lambdaIp?: string };
    const baseUrl = body.lambdaIp?.startsWith("http")
      ? body.lambdaIp
      : `http://${body.lambdaIp}`;
    return {
      provider: "sulphur-ltx",
      status: "healthy",
      acceptingSubmissions: true,
      killSwitch: false,
      lastHeartbeatAt: nowIso(),
      queueDepth: generations.filter((g) =>
        ["queued", "preparing", "generating", "uploading"].includes(g.status),
      ).length,
      updatedAt: nowIso(),
      baseUrl,
      health: { ok: true, provider: "browser-demo", message: "healthy" },
    } as T;
  }

  if (path.startsWith("/v1/admin/runtime/") && method === "POST") {
    return demoApi<T>("/v1/runtime/status");
  }

  throw new Error(`No demo handler for ${method} ${path}`);
}

async function api<T>(path: string, init: RequestInit = {}) {
  try {
    const r = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${token()}`,
        ...init.headers,
      },
    });
    if (!r.ok) {
      if (r.status === 404 && path !== "/v1/admin/runtime/connect") {
        return demoApi<T>(path, init);
      }

      let message = r.statusText;
      try {
        message = ((await r.json()) as { detail?: string }).detail ?? message;
      } catch {
        message = `API unavailable (${r.status})`;
      }
      throw new Error(message);
    }
    return r.json() as Promise<T>;
  } catch (error) {
    if (error instanceof TypeError) return demoApi<T>(path, init);
    throw error;
  }
}
function Shell() {
  const navItems = [
    { to: "/", label: "Video Lab" },
    { to: "/studio", label: "LongForm Studio" },
    { to: "/sulphur", label: "Sulphur" },
    { to: "/gallery", label: "Gallery" },
    { to: "/account", label: "Account" },
    { to: "/admin", label: "Admin" },
  ];

  return (
    <>
      <nav className="site-nav" aria-label="Primary navigation">
        {navItems.map((item) => (
          <NavLink
            key={item.to}
            to={item.to}
            className={({ isActive }) =>
              isActive ? "nav-link active" : "nav-link"
            }
            end={item.to === "/"}
          >
            {item.label}
          </NavLink>
        ))}
      </nav>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/studio" element={<LongFormStoryboardStudio />} />
        <Route path="/sulphur" element={<Studio />} />
        <Route path="/gallery" element={<Gallery />} />
        <Route path="/generations/:id" element={<Detail />} />
        <Route path="/account" element={<Account />} />
        <Route path="/admin" element={<Admin />} />
      </Routes>
    </>
  );
}
function Logo() {
  return (
    <img
      src="/intelligensiai-ai-white.png"
      alt="Intelligensi.ai"
      className="logo"
    />
  );
}
function Landing() {
  return (
    <main className="hero">
      <Logo />
      <div className="badge">Video Lab</div>
      <h1>Cinematic AI video generation.</h1>
      <p>
        Direct a longer film scene by scene with real frame-to-frame continuity
        through the LongForm LTX Storyboard Studio.
      </p>
      <div className="prompts">
        <span>Plan a complete visual story</span>
        <span>Anchor start and end frames</span>
        <span>Edit cinematic transitions</span>
      </div>
      <Link className="button" to="/studio">
        Start creating
      </Link>
      <footer>
        <a>Privacy</a>
        <a>Terms</a>
        <small>Trial credits are limited and non-transferable.</small>
      </footer>
    </main>
  );
}
function Studio() {
  const nav = useNavigate();
  const credits = useQuery({
    queryKey: ["credits"],
    queryFn: () => api<CreditWallet>("/v1/credits"),
  });
  const runtime = useQuery({
    queryKey: ["runtime"],
    queryFn: () => api<RuntimeStatus>("/v1/runtime/status"),
  });
  const [prompt, setPrompt] = useState(
    "A cinematic reveal of an intelligent glass monolith floating over an ocean at sunrise",
  );
  const [quality, setQuality] = useState<"draft" | "standard" | "high">(
    "standard",
  );
  const create = useMutation({
    mutationFn: () =>
      api<Generation>("/v1/generations", {
        method: "POST",
        headers: { "Idempotency-Key": crypto.randomUUID() },
        body: JSON.stringify({
          prompt,
          settings: { aspectRatio: "16:9", durationSeconds: 4, quality },
        }),
      }),
    onSuccess: (g) => nav(`/generations/${g.id}`),
  });
  return (
    <main>
      <h1>Studio</h1>
      <section className="panel">
        <textarea
          value={prompt}
          maxLength={1200}
          onChange={(e) => setPrompt(e.target.value)}
        />
        <p>{prompt.length}/1200 characters</p>
        <div className="chips">
          {["Volumetric light", "Handheld documentary", "Epic drone shot"].map(
            (p) => (
              <button onClick={() => setPrompt(prompt + " " + p)}>{p}</button>
            ),
          )}
        </div>
        <label>
          Quality{" "}
          <select
            value={quality}
            onChange={(e) => setQuality(e.target.value as typeof quality)}
          >
            <option>draft</option>
            <option>standard</option>
            <option>high</option>
          </select>
        </label>
        <div className="drop">
          Optional start, end, or reference image upload target is available
          through the API.
        </div>
        <p>
          Credits: {credits.data?.available ?? "…"} available /{" "}
          {credits.data?.reserved ?? 0} reserved
        </p>
        <p>
          Runtime: {runtime.data?.status} · Queue depth{" "}
          {runtime.data?.queueDepth}
        </p>
        {create.error && <p className="error">{create.error.message}</p>}
        <button
          className="button"
          disabled={create.isPending}
          onClick={() => create.mutate()}
        >
          {create.isPending ? "Submitting…" : "Generate video"}
        </button>
      </section>
    </main>
  );
}
function Gallery() {
  const q = useQuery({
    queryKey: ["gallery"],
    queryFn: () => api<{ items: Generation[] }>("/v1/gallery"),
  });
  return (
    <main>
      <h1>Personal Gallery</h1>
      <div className="grid">
        {q.data?.items.length ? (
          q.data.items.map((g) => (
            <article className="card">
              <div className="thumb">{g.status}</div>
              <h3>{g.prompt}</h3>
              <p>{new Date(g.createdAt).toLocaleString()}</p>
              <Link to={`/generations/${g.id}`}>Open details</Link>
            </article>
          ))
        ) : (
          <p className="empty">
            No generations yet. Create your first cinematic clip.
          </p>
        )}
      </div>
    </main>
  );
}
function Detail() {
  const { id } = useParams();
  const q = useQuery({
    queryKey: ["gen", id],
    queryFn: () => api<Generation>(`/v1/generations/${id}`),
    refetchInterval: 1500,
  });
  const proc = useMutation({
    mutationFn: () => api("/v1/dev/process-one", { method: "POST" }),
    onSuccess: () => q.refetch(),
  });
  const cancel = useMutation({
    mutationFn: () =>
      api<Generation>(`/v1/generations/${id}/cancel`, { method: "POST" }),
    onSuccess: () => q.refetch(),
  });
  const g = q.data;
  return (
    <main>
      {g && (
        <>
          <h1>Generation</h1>
          <section className="panel">
            <div className="thumb big">{g.status}</div>
            <p>{g.prompt}</p>
            <p>
              Cost: {g.creditCost} credits · Created{" "}
              {new Date(g.createdAt).toLocaleString()}
            </p>
            {g.safeErrorMessage && (
              <p className="error">{g.safeErrorMessage}</p>
            )}
            {g.output?.downloadUrl && (
              <a className="button" href={g.output.downloadUrl}>
                Download
              </a>
            )}
            <button onClick={() => navigator.clipboard.writeText(g.prompt)}>
              Copy prompt
            </button>
            <Link to="/studio">Create variation</Link>
            {!["completed", "failed", "cancelled"].includes(g.status) && (
              <button onClick={() => cancel.mutate()}>Cancel</button>
            )}
            <button onClick={() => proc.mutate()}>Run mock worker</button>
          </section>
        </>
      )}
    </main>
  );
}
function Account() {
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me") });
  const cr = useQuery({
    queryKey: ["credits"],
    queryFn: () => api<CreditWallet>("/v1/credits"),
  });
  return (
    <main>
      <h1>Account</h1>
      <section className="panel">
        <p>{me.data?.email}</p>
        <p>Roles: {me.data?.roles.join(", ") || "creator"}</p>
        <p>Terms: {me.data?.termsVersion}</p>
        <p>Trial granted: {me.data?.trialGrantedAt}</p>
        <p>
          Available {cr.data?.available}; reserved {cr.data?.reserved}; spent{" "}
          {cr.data?.spent}
        </p>
        <button
          onClick={() => {
            localStorage.removeItem("vl_token");
            location.href = "/";
          }}
        >
          Sign out
        </button>
        <p>
          Data deletion request: contact operations; functional workflow is
          prepared for production support.
        </p>
        <button disabled>Credit packs coming soon</button>
      </section>
    </main>
  );
}
function Admin() {
  const queryClient = useQueryClient();
  const [lambdaIp, setLambdaIp] = useState("");
  const [connection, setConnection] = useState<RuntimeConnectResponse>();
  const [connectError, setConnectError] = useState<string>();
  const [currentToken, setCurrentToken] = useState(token());
  const r = useQuery({
    queryKey: ["runtime"],
    queryFn: () => api<RuntimeStatus>("/v1/runtime/status"),
  });
  const call = (p: string) =>
    api<RuntimeStatus>(p, { method: "POST" }).then(() => r.refetch());
  const connect = useMutation({
    mutationFn: () =>
      api<RuntimeConnectResponse>("/v1/admin/runtime/connect", {
        method: "POST",
        body: JSON.stringify({ lambdaIp }),
      }),
    onSuccess: (result) => {
      setConnection(result);
      setConnectError(undefined);
      r.refetch();
    },
    onError: (error) => {
      setConnection(undefined);
      setConnectError(
        error instanceof Error ? error.message : "Runtime connection failed",
      );
    },
  });
  return (
    <main>
      <h1>Admin Console</h1>
      <section className="panel">
        <p>Local token: {currentToken}</p>
        {currentToken !== "admin-token" && (
          <button
            onClick={() => {
              localStorage.setItem("vl_token", "admin-token");
              setCurrentToken("admin-token");
              setConnectError(undefined);
              setConnection(undefined);
              queryClient.invalidateQueries();
            }}
          >
            Use local admin token
          </button>
        )}
        <h2>Lambda runtime connection</h2>
        <div className="runtime-connect">
          <label>
            Lambda IP address
            <input
              value={lambdaIp}
              onChange={(event) => {
                setLambdaIp(event.target.value);
                setConnection(undefined);
                setConnectError(undefined);
              }}
              placeholder="150.136.94.140"
            />
          </label>
          <button
            disabled={!lambdaIp.trim() || connect.isPending}
            onClick={() => connect.mutate()}
          >
            {connect.isPending ? "Checking…" : "Connect"}
          </button>
        </div>
        {connection && (
          <p className="success">
            Connected to {connection.baseUrl}. Runtime status:{" "}
            {connection.status}.
          </p>
        )}
        {connectError && <p className="error">{connectError}</p>}
        <pre>{JSON.stringify(r.data, null, 2)}</pre>
        <button onClick={() => call("/v1/admin/runtime/pause")}>
          Pause submissions
        </button>
        <button onClick={() => call("/v1/admin/runtime/resume")}>Resume</button>
        <button onClick={() => call("/v1/admin/runtime/stop")}>
          Kill switch
        </button>
        <p>
          Use admin-token locally to exercise backend-enforced admin claims.
        </p>
      </section>
    </main>
  );
}
createRoot(document.getElementById("root")!).render(
  <QueryClientProvider client={new QueryClient()}>
    <BrowserRouter>
      <Shell />
    </BrowserRouter>
  </QueryClientProvider>,
);
