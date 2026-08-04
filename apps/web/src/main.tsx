import React, { useEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  BrowserRouter,
  Link,
  Navigate,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
  useParams,
} from "react-router";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import type { Generation, RuntimeStatus, Me } from "@video-lab/contracts";
import { useAuthenticatedVideo } from "./AuthenticatedVideo.js";
import {
  completeGoogleRedirectSignIn,
  getApiToken,
  getFriendlyAuthError,
  isProductionFirebase,
  loadRegistrationProfile,
  observeAuth,
  registerWithEmail,
  requestPasswordReset,
  saveRegistrationProfile,
  signInWithEmail,
  signInWithGoogle,
  signOutUser,
} from "./auth.js";
import type { User } from "firebase/auth";
import homeMarkUrl from "../../../public/fav-icon.png";
import "./style.css";
const API = import.meta.env.VITE_API_BASE_URL ?? "/api";
const LongFormStoryboardStudio = React.lazy(
  () => import("./LongFormStoryboardStudio.js"),
);
const DirectorWorkspace = React.lazy(
  () => import("./DirectorWorkspace.js"),
);
const DEMO_GENERATIONS_KEY = "vl_demo_generations";
const ENABLE_DEMO_API =
  import.meta.env.DEV && import.meta.env.VITE_ENABLE_DEMO_API === "true";
const token = () => localStorage.getItem("vl_token") || "demo-user";

type GenerationRequest = {
  prompt: string;
  settings: Generation["settings"];
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
    return {
      uid: token(),
      available: 0,
      reserved: 0,
      spent: 0,
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

  const deleteGenerationMatch = path.match(/^\/v1\/generations\/([^/]+)$/);
  if (deleteGenerationMatch && method === "DELETE") {
    writeDemoGenerations(
      generations.filter((g) => g.id !== deleteGenerationMatch[1]),
    );
    return undefined as T;
  }

  if (path === "/v1/generations" && method === "POST") {
    const body = JSON.parse(String(init.body ?? "{}")) as GenerationRequest;
    const generation: Generation = {
      id: `demo_${crypto.randomUUID()}`,
      prompt: body.prompt,
      settings: body.settings,
      status: "queued",
      queuePosition: 1,
      creditCost: 0,
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

  if (path === "/v1/admin/runtime/discover" && method === "POST") {
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
      discovery: {
        source: "deploy-studio",
        state: "connected",
        leaseExpiresAt: undefined,
        lastPublishedAt: nowIso(),
        message: "Deploy Studio runtime lease is non-expiring for now",
      },
    } as T;
  }

  if (path.startsWith("/v1/admin/runtime/") && method === "POST") {
    return demoApi<T>("/v1/runtime/status");
  }

  throw new Error(`No demo handler for ${method} ${path}`);
}

async function api<T>(path: string, init: RequestInit = {}) {
  try {
    const apiToken = await getApiToken();
    const r = await fetch(`${API}${path}`, {
      ...init,
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${apiToken}`,
        ...init.headers,
      },
    });
    if (!r.ok) {
      if (
        ENABLE_DEMO_API &&
        r.status === 404 &&
        path !== "/v1/admin/runtime/discover"
      ) {
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
    if (r.status === 204) return undefined as T;
    return r.json() as Promise<T>;
  } catch (error) {
    if (ENABLE_DEMO_API && error instanceof TypeError) {
      return demoApi<T>(path, init);
    }
    throw error;
  }
}
function Shell() {
  const location = useLocation();
  const navigate = useNavigate();
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authReady, setAuthReady] = useState(!isProductionFirebase);
  useEffect(
    () =>
      observeAuth((user) => {
        setFirebaseUser(user);
        setAuthReady(true);
      }),
    [],
  );
  const signedIn =
    !isProductionFirebase || Boolean(firebaseUser && !firebaseUser.isAnonymous);
  const me = useQuery({
    queryKey: ["me", firebaseUser?.uid ?? token()],
    queryFn: () => api<Me>("/v1/me"),
    enabled: signedIn,
  });
  const isLanding = location.pathname === "/";
  const navItems = [
    { to: "/storyboard", label: "Storyboard Studio" },
    { to: "/gallery", label: "Gallery" },
    { to: "/account", label: "Account" },
    ...(me.data?.roles.includes("admin")
      ? [{ to: "/admin", label: "Admin" }]
      : []),
  ];
  const logout = async () => {
    await signOutUser();
    navigate("/login", { replace: true });
  };

  return (
    <>
      <nav
        className={`site-nav${signedIn ? " logged-in" : ""}`}
        aria-label="Primary navigation"
      >
        <div className="site-nav-inner">
          <Link className="site-home-mark" to="/" aria-label="Video Lab home">
            <img src={homeMarkUrl} alt="" />
          </Link>
          {!isLanding && !signedIn && (
            <Link
              className="site-brand"
              to="/"
              aria-label="Intelligensi.ai Video Lab home"
            >
              intelligensi<span>.ai</span> <b>Video Lab</b>
            </Link>
          )}
          {signedIn && (
            <div className="site-nav-links">
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
            </div>
          )}
          {signedIn && (
            <button className="site-logout" type="button" onClick={logout}>
              Log out
            </button>
          )}
          {authReady && !signedIn && (
            <div className="site-auth-links">
              <NavLink to="/login">Log in</NavLink>
              <NavLink className="site-register-link" to="/register">
                Register
              </NavLink>
            </div>
          )}
        </div>
      </nav>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<AuthEntry mode="login" />} />
        <Route path="/register" element={<AuthEntry mode="register" />} />
        <Route
          path="/storyboard"
          element={
            <ProtectedRoute
              element={
                <React.Suspense
                  fallback={
                    <main className="auth-page">
                      <p>Opening your storyboard…</p>
                    </main>
                  }
                >
                  <DirectorWorkspace />
                </React.Suspense>
              }
            />
          }
        />
        <Route
          path="/storyboard/classic"
          element={
            <ProtectedRoute
              element={
                <React.Suspense
                  fallback={
                    <main className="auth-page">
                      <p>Opening the classic storyboard studio...</p>
                    </main>
                  }
                >
                  <LongFormStoryboardStudio />
                </React.Suspense>
              }
            />
          }
        />
        <Route
          path="/experimental/director-workspace"
          element={<Navigate to="/storyboard" replace />}
        />
        <Route path="/studio" element={<Navigate to="/storyboard" replace />} />
        <Route
          path="/sulphur"
          element={<Navigate to="/storyboard" replace />}
        />
        <Route
          path="/gallery"
          element={<ProtectedRoute element={<Gallery />} />}
        />
        <Route
          path="/generations/:id"
          element={<ProtectedRoute element={<Detail />} />}
        />
        <Route
          path="/onboarding"
          element={<ProtectedRoute element={<Registration />} />}
        />
        <Route
          path="/account"
          element={<ProtectedRoute element={<Account />} />}
        />
        <Route
          path="/admin"
          element={<ProtectedRoute element={<AdminRoute />} />}
        />
      </Routes>
    </>
  );
}

function AdminRoute() {
  const me = useQuery({
    queryKey: ["me", "admin-gate"],
    queryFn: () => api<Me>("/v1/me"),
  });
  if (me.isLoading)
    return (
      <main>
        <p>Checking administrator access…</p>
      </main>
    );
  if (!me.data?.roles.includes("admin"))
    return <Navigate to="/storyboard" replace />;
  return <Admin />;
}

function ProtectedRoute({ element }: { element: React.ReactNode }) {
  const location = useLocation();
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!isProductionFirebase);
  useEffect(
    () =>
      observeAuth((user) => {
        setFirebaseUser(user);
        setReady(true);
      }),
    [],
  );

  if (!isProductionFirebase) return element;
  if (!ready)
    return (
      <main className="auth-page">
        <div className="auth-card">
          <p>Restoring your Video Lab session…</p>
        </div>
      </main>
    );
  if (!firebaseUser || firebaseUser.isAnonymous) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }
  return element;
}

function AuthEntry({ mode }: { mode: "login" | "register" }) {
  const navigate = useNavigate();
  const location = useLocation();
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [ready, setReady] = useState(!isProductionFirebase);
  const [busy, setBusy] = useState(false);
  const [busyAction, setBusyAction] = useState<"google" | "email" | "reset">();
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [discoverySource, setDiscoverySource] = useState("");
  const [subscribeEmail, setSubscribeEmail] = useState(false);
  const [acceptedTerms, setAcceptedTerms] = useState(false);
  const requestedPath = (location.state as { from?: string } | null)?.from;
  const destination =
    mode === "register" ? "/onboarding" : requestedPath || "/storyboard";
  useEffect(
    () =>
      observeAuth((user) => {
        setFirebaseUser(user);
        setReady(true);
      }),
    [],
  );
  useEffect(() => {
    if (!isProductionFirebase) return;
    completeGoogleRedirectSignIn()
      .then((user) => {
        if (user && !user.isAnonymous) navigate(destination, { replace: true });
      })
      .catch((cause) => setError(getFriendlyAuthError(cause)));
  }, [destination, navigate]);
  useEffect(() => {
    if (ready && !busy && firebaseUser && !firebaseUser.isAnonymous)
      navigate(destination, { replace: true });
  }, [busy, destination, firebaseUser, navigate, ready]);
  const connect = async () => {
    setBusy(true);
    setBusyAction("google");
    setError(undefined);
    setNotice(undefined);
    try {
      await signInWithGoogle();
    } catch (cause) {
      setError(getFriendlyAuthError(cause));
    } finally {
      setBusy(false);
      setBusyAction(undefined);
    }
  };
  const submitEmail = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(undefined);
    setNotice(undefined);
    if (mode === "register") {
      if (name.trim().length < 2) return setError("Enter your full name.");
      if (password.length < 8)
        return setError("Create a password with at least 8 characters.");
      if (password !== confirmPassword)
        return setError("The two passwords do not match.");
      if (!discoverySource)
        return setError("Tell us how you heard about Video Lab.");
      if (!acceptedTerms)
        return setError(
          "Please accept the Terms and Privacy Policy to create an account.",
        );
    }
    if (!email.trim() || !password)
      return setError("Enter your email and password.");
    setBusy(true);
    setBusyAction("email");
    try {
      if (mode === "register") {
        await registerWithEmail(name, email, password);
        await saveRegistrationProfile({
          preferredName: name.trim(),
          discoverySource,
          productUpdates: subscribeEmail,
          registrationMethod: "password",
          termsAcceptedAt: new Date().toISOString(),
          signupCompletedAt: new Date().toISOString(),
        });
      } else {
        await signInWithEmail(email, password);
      }
      navigate(destination, { replace: true });
    } catch (cause) {
      setError(getFriendlyAuthError(cause));
    } finally {
      setBusy(false);
      setBusyAction(undefined);
    }
  };
  const resetPassword = async () => {
    setError(undefined);
    setNotice(undefined);
    if (!email.trim()) return setError("Enter your email address first.");
    setBusy(true);
    setBusyAction("reset");
    try {
      await requestPasswordReset(email);
      setNotice("Password reset email sent. Check your inbox.");
    } catch (cause) {
      setError(getFriendlyAuthError(cause));
    } finally {
      setBusy(false);
      setBusyAction(undefined);
    }
  };

  return (
    <main className="auth-page">
      <section className="auth-card">
        <Link className="auth-brand" to="/">
          intelligensi<span>.ai</span> <b>Video Lab</b>
        </Link>
        <span className="auth-eyebrow">
          {mode === "login" ? "Welcome back" : "Create your account"}
        </span>
        <h1>{mode === "login" ? "Login" : "Join Video Lab"}</h1>
        <p>
          {mode === "login"
            ? "Continue creating cinematic video, storyboards and connected scenes."
            : "Create your private workspace for cinematic AI video and storyboard production."}
        </p>
        <button
          className="auth-google"
          type="button"
          disabled={busy || !ready}
          onClick={connect}
        >
          <span>G</span>
          {busyAction === "google" ? "Connecting…" : `Continue with Google`}
        </button>
        <div className="auth-divider">
          <span>or use email</span>
        </div>
        <form className="auth-email-form" onSubmit={submitEmail}>
          {mode === "register" && (
            <label>
              <span>Full name</span>
              <input
                type="text"
                autoComplete="name"
                value={name}
                placeholder="Your name"
                required
                onChange={(event) => setName(event.target.value)}
              />
            </label>
          )}
          <label>
            <span>Email address</span>
            <input
              type="email"
              autoComplete="email"
              value={email}
              placeholder="you@example.com"
              required
              onChange={(event) => setEmail(event.target.value)}
            />
          </label>
          <div className={mode === "register" ? "auth-password-grid" : ""}>
            <label>
              <span>
                {mode === "register" ? "Create password" : "Password"}
              </span>
              <input
                type="password"
                autoComplete={
                  mode === "register" ? "new-password" : "current-password"
                }
                value={password}
                placeholder={
                  mode === "register"
                    ? "At least 8 characters"
                    : "Your password"
                }
                minLength={mode === "register" ? 8 : undefined}
                required
                onChange={(event) => setPassword(event.target.value)}
              />
            </label>
            {mode === "register" && (
              <label>
                <span>Repeat password</span>
                <input
                  type="password"
                  autoComplete="new-password"
                  value={confirmPassword}
                  placeholder="Repeat your password"
                  minLength={8}
                  required
                  onChange={(event) => setConfirmPassword(event.target.value)}
                />
              </label>
            )}
          </div>
          {mode === "register" && (
            <>
              <label>
                <span>How did you hear about us?</span>
                <select
                  value={discoverySource}
                  required
                  onChange={(event) => setDiscoverySource(event.target.value)}
                >
                  <option value="">Select one</option>
                  <option>Search engine</option>
                  <option>Social media</option>
                  <option>Friend or colleague</option>
                  <option>Event or community</option>
                  <option>Article or newsletter</option>
                  <option>Other</option>
                </select>
              </label>
              <div className="auth-consents">
                <label>
                  <input
                    type="checkbox"
                    checked={subscribeEmail}
                    onChange={(event) =>
                      setSubscribeEmail(event.target.checked)
                    }
                  />
                  <span>
                    <b>Subscribe to email updates</b>
                    <small>
                      Product news, creative ideas and occasional Video Lab
                      updates. You can unsubscribe at any time.
                    </small>
                  </span>
                </label>
                <label>
                  <input
                    type="checkbox"
                    required
                    checked={acceptedTerms}
                    onChange={(event) => setAcceptedTerms(event.target.checked)}
                  />
                  <span>
                    <b>I agree to the Terms and Privacy Policy</b>
                    <small>
                      Required to create your private Video Lab account.
                    </small>
                  </span>
                </label>
              </div>
            </>
          )}
          <button
            className="auth-email-submit"
            type="submit"
            disabled={busy || !ready}
          >
            {busyAction === "email"
              ? mode === "register"
                ? "Creating account…"
                : "Logging in…"
              : mode === "register"
                ? "Create account"
                : "Login"}
          </button>
          {mode === "login" && (
            <button
              className="auth-reset"
              type="button"
              disabled={busy}
              onClick={resetPassword}
            >
              {busyAction === "reset" ? "Sending…" : "Forgot password?"}
            </button>
          )}
        </form>
        {error && <p className="error">{error}</p>}
        {notice && <p className="auth-notice">{notice}</p>}
        <div className="auth-switch">
          {mode === "login" ? (
            <>
              New to Video Lab? <Link to="/register">Create an account</Link>
            </>
          ) : (
            <>
              Already have an account? <Link to="/login">Log in</Link>
            </>
          )}
        </div>
        <small>
          By continuing, you agree to use Video Lab responsibly. Your workspace
          is private by default.
        </small>
      </section>
    </main>
  );
}

function Landing() {
  return (
    <main className="home">
      <section className="home-hero">
        <div className="home-copy">
          <div className="home-kicker">
            <span>●</span> Cinematic AI creation platform
          </div>
          <h1>
            <img src="/intelligensi-logo.png" alt="intelligensi.ai" />
            <em>Video Lab.</em>
          </h1>
          <p>
            Shape cinematic AI video scene by scene. Direct the image, movement
            and transition—then carry visual continuity across the whole film.
          </p>
          <div className="home-actions">
            <Link className="home-primary" to="/storyboard">
              Start creating <span>↗</span>
            </Link>
            <Link className="home-secondary" to="/gallery">
              Explore your gallery
            </Link>
          </div>
          <div className="home-proof">
            <span>
              <b>6</b> scenes
            </span>
            <span>
              <b>Frame</b> continuity
            </span>
            <span>
              <b>Private</b> by default
            </span>
          </div>
        </div>
        <div className="home-visual">
          <div className="home-orbit home-orbit-one" />
          <div className="home-orbit home-orbit-two" />
          <figure>
            <video
              autoPlay
              muted
              loop
              playsInline
              preload="metadata"
              poster="/images/longform-ltx-storyboard-studio-film-roll.webp"
              aria-label="A cinematic film strip carrying a sequence of connected storyboard scenes"
            >
              <source src="/Video-lab-startup-video.mp4" type="video/mp4" />
            </video>
            <figcaption>
              <span>Continuity engine</span>
              <strong>One film. Every frame connected.</strong>
            </figcaption>
          </figure>
          <div className="home-float home-float-top">
            <i /> Generator ready
          </div>
          <Link className="home-float home-float-bottom" to="/login">
            <b>Login / Register</b>
            <span>Enter Video Lab</span>
          </Link>
        </div>
      </section>

      <section
        className="home-marquee"
        aria-label="Video creation capabilities"
      >
        <div>
          STORYBOARD <span>✦</span> FRAME ANCHORS <span>✦</span> CINEMATIC
          TRANSITIONS <span>✦</span> LTX VIDEO <span>✦</span> STORYBOARD{" "}
          <span>✦</span>
        </div>
      </section>

      <section className="home-suite">
        <header>
          <span>Creative control, without the complexity</span>
          <h2>
            From first frame
            <br />
            to final cut.
          </h2>
        </header>
        <div className="home-cards">
          <article>
            <b>01</b>
            <h3>Direct the story</h3>
            <p>Plan up to 24 scenes around one clear artistic goal.</p>
          </article>
          <article>
            <b>02</b>
            <h3>Anchor the image</h3>
            <p>
              Guide characters, composition and style with visual references.
            </p>
          </article>
          <article>
            <b>03</b>
            <h3>Carry continuity</h3>
            <p>
              Flow the final frame of each scene into the opening of the next.
            </p>
          </article>
          <article>
            <b>04</b>
            <h3>Finish the cut</h3>
            <p>Control timing, transitions and production settings.</p>
          </article>
        </div>
      </section>

      <section className="home-final">
        <div>
          <span>Make the film only you can imagine.</span>
          <h2>Ready when you are.</h2>
        </div>
        <Link className="home-primary" to="/storyboard">
          Open Storyboard <span>↗</span>
        </Link>
      </section>

      <footer className="home-footer">
        <span>© 2026 Intelligensi.ai</span>
        <div>
          <a>Privacy</a>
          <a>Terms</a>
        </div>
        <small>Your films are private by default.</small>
      </footer>
    </main>
  );
}
function Gallery() {
  const q = useQuery({
    queryKey: ["gallery"],
    queryFn: () => api<{ items: Generation[] }>("/v1/gallery"),
  });
  const queryClient = useQueryClient();
  const deletion = useMutation({
    mutationFn: (id: string) =>
      api<void>(`/v1/generations/${id}`, { method: "DELETE" }),
    onSuccess: (_result, id) => {
      localStorage.removeItem(`vl_thumbnail_${id}`);
      queryClient.setQueryData<{ items: Generation[] }>(
        ["gallery"],
        (current) => ({
          items: (current?.items ?? []).filter((item) => item.id !== id),
        }),
      );
      void queryClient.invalidateQueries({ queryKey: ["gallery"] });
    },
  });
  return (
    <main className="gallery-page">
      <h1 className="editorial-page-title">
        Gallery<span className="editorial-title-stop">.</span>
      </h1>
      {deletion.error && (
        <p className="error" role="alert">
          Delete failed: {deletion.error.message}
        </p>
      )}
      <div className="gallery-grid">
        {q.data?.items.length ? (
          q.data.items.map((g) => (
            <GalleryCard
              generation={g}
              key={g.id}
              deleting={deletion.variables === g.id && deletion.isPending}
              onDelete={(id) => deletion.mutate(id)}
            />
          ))
        ) : (
          <p className={q.error ? "error" : "empty"}>
            {q.error
              ? `Gallery unavailable: ${q.error.message}`
              : "No generations yet. Create your first cinematic clip."}
          </p>
        )}
      </div>
    </main>
  );
}
function GalleryCard({
  generation,
  deleting,
  onDelete,
}: {
  generation: Generation;
  deleting: boolean;
  onDelete: (id: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const promptNeedsToggle = generation.prompt.length > 190;
  const requestDelete = () => {
    const confirmed = window.confirm(
      "Delete this video from your gallery and Firebase Storage?",
    );
    if (confirmed) onDelete(generation.id);
  };
  return (
    <article className="card gallery-card">
      <GalleryArtifact generation={generation} />
      <button
        className="gallery-delete"
        type="button"
        aria-label="Delete video"
        disabled={deleting}
        onClick={requestDelete}
      >
        <svg viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3 6h18" />
          <path d="M8 6V4h8v2" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v5" />
          <path d="M14 11v5" />
        </svg>
      </button>
      <div className="gallery-card-body">
        <div className="gallery-card-meta">
          <span>{generation.status}</span>
          <time dateTime={generation.createdAt}>
            {new Date(generation.createdAt).toLocaleString()}
          </time>
        </div>
        <h3 className={expanded ? "expanded" : ""}>{generation.prompt}</h3>
        {promptNeedsToggle && (
          <button
            className="gallery-prompt-toggle"
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? "View less" : "View more"}
          </button>
        )}
        <Link className="gallery-card-link" to={`/generations/${generation.id}`}>
          Open details
        </Link>
      </div>
    </article>
  );
}
function GalleryArtifact({ generation }: { generation: Generation }) {
  const video = useAuthenticatedVideo(generation.output?.downloadUrl);
  const storageKey = `vl_thumbnail_${generation.id}`;
  const [thumbnail, setThumbnail] = useState(
    () => localStorage.getItem(storageKey) ?? "",
  );

  useEffect(() => {
    if (thumbnail || !video.objectUrl) return;
    const source = document.createElement("video");
    const canvas = document.createElement("canvas");
    const context = canvas.getContext("2d", { willReadFrequently: true });
    if (!context) return;
    let cancelled = false;
    let best: { score: number; image: string } | undefined;
    let sampleIndex = 0;
    const samplePositions = [0.12, 0.28, 0.44, 0.6, 0.76, 0.9];
    canvas.width = 640;
    canvas.height = 480;
    source.src = video.objectUrl;
    source.muted = true;
    source.playsInline = true;
    source.preload = "auto";

    const finish = () => {
      if (cancelled || !best) return;
      try {
        localStorage.setItem(storageKey, best.image);
      } catch {
        /* Thumbnail cache is optional. */
      }
      setThumbnail(best.image);
    };
    const sample = () => {
      if (cancelled) return;
      const width = source.videoWidth;
      const height = source.videoHeight;
      if (!width || !height) return finish();
      const sourceRatio = width / height;
      const targetRatio = 4 / 3;
      let sx = 0;
      let sy = 0;
      let sw = width;
      let sh = height;
      if (sourceRatio > targetRatio) {
        sw = height * targetRatio;
        sx = (width - sw) / 2;
      } else {
        sh = width / targetRatio;
        sy = (height - sh) / 2;
      }
      context.drawImage(source, sx, sy, sw, sh, 0, 0, canvas.width, canvas.height);
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      let luminanceTotal = 0;
      let luminanceSquared = 0;
      for (let index = 0; index < pixels.length; index += 16) {
        const luminance =
          pixels[index] * 0.2126 +
          pixels[index + 1] * 0.7152 +
          pixels[index + 2] * 0.0722;
        luminanceTotal += luminance;
        luminanceSquared += luminance * luminance;
      }
      const count = pixels.length / 16;
      const mean = luminanceTotal / count;
      const variance = Math.max(0, luminanceSquared / count - mean * mean);
      if (mean > 18 && mean < 237) {
        const score = variance + Math.min(mean, 255 - mean) * 12;
        if (!best || score > best.score)
          best = { score, image: canvas.toDataURL("image/jpeg", 0.78) };
      }
      sampleIndex += 1;
      if (sampleIndex >= samplePositions.length) finish();
      else
        source.currentTime = Math.max(
          0.01,
          source.duration * samplePositions[sampleIndex],
        );
    };
    source.addEventListener(
      "loadedmetadata",
      () => {
        source.currentTime = Math.max(
          0.01,
          source.duration * samplePositions[0],
        );
      },
      { once: true },
    );
    source.addEventListener("seeked", sample);
    source.addEventListener("error", finish, { once: true });
    return () => {
      cancelled = true;
      source.removeAttribute("src");
      source.load();
    };
  }, [storageKey, thumbnail, video.objectUrl]);

  if (thumbnail) {
    return (
      <div className="gallery-media gallery-thumbnail">
        <img src={thumbnail} alt="Video thumbnail" />
        <span aria-hidden="true" />
      </div>
    );
  }
  if (video.error) {
    return (
      <div className="thumb error gallery-media">
        Video unavailable: {video.error}
      </div>
    );
  }
  return (
    <div className="thumb gallery-media">
      {generation.output?.downloadUrl ? "Retrieving video…" : generation.status}
    </div>
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
  const video = useAuthenticatedVideo(g?.output?.downloadUrl);
  return (
    <main>
      {g && (
        <>
          <h1>Generation</h1>
          <section className="panel generation-detail-panel">
            {video.objectUrl ? (
              <video
                className="video-preview"
                src={video.objectUrl}
                controls
                autoPlay
              />
            ) : (
              <div className="thumb big">
                {g.output?.downloadUrl
                  ? "Retrieving completed video…"
                  : g.status}
              </div>
            )}
            {video.error && (
              <p className="error">Video retrieval failed: {video.error}</p>
            )}
            <p>{g.prompt}</p>
            <p>Created {new Date(g.createdAt).toLocaleString()}</p>
            {g.safeErrorMessage && (
              <p className="error">{g.safeErrorMessage}</p>
            )}
            <div className="generation-detail-actions">
              {video.objectUrl && (
                <a
                  className="button"
                  href={video.objectUrl}
                  download={`${g.id}.mp4`}
                >
                  Download
                </a>
              )}
              <button onClick={() => navigator.clipboard.writeText(g.prompt)}>
                Copy prompt
              </button>
              <Link className="button" to="/storyboard">
                Create Variation
              </Link>
              {!["completed", "failed", "cancelled"].includes(g.status) && (
                <button onClick={() => cancel.mutate()}>Cancel</button>
              )}
              {import.meta.env.DEV &&
                import.meta.env.VITE_ENABLE_DEMO_API === "true" && (
                  <button onClick={() => proc.mutate()}>
                    Run local mock worker
                  </button>
                )}
            </div>
          </section>
        </>
      )}
    </main>
  );
}
type RegistrationProfile = {
  country: string;
  industry: string;
  role: string;
  teamSize: string;
  discoverySource: string;
  primaryGoal: string;
  experienceLevel: string;
  productUpdates: boolean;
  researchInvites: boolean;
  completedAt?: string;
};

const emptyRegistration: RegistrationProfile = {
  country: "",
  industry: "",
  role: "",
  teamSize: "",
  discoverySource: "",
  primaryGoal: "",
  experienceLevel: "",
  productUpdates: false,
  researchInvites: false,
};

function Registration() {
  const navigate = useNavigate();
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string>();
  const [profile, setProfile] = useState<RegistrationProfile>(() => {
    try {
      return {
        ...emptyRegistration,
        ...JSON.parse(localStorage.getItem("vl_registration") ?? "{}"),
      };
    } catch {
      return emptyRegistration;
    }
  });
  useEffect(
    () =>
      observeAuth((user) => {
        setFirebaseUser(user);
        if (user && !user.isAnonymous) {
          void loadRegistrationProfile()
            .then((stored) => {
              if (Object.keys(stored).length)
                setProfile((current) => ({ ...current, ...stored }));
            })
            .catch(() => undefined);
        }
      }),
    [],
  );
  const update = <K extends keyof RegistrationProfile>(
    key: K,
    value: RegistrationProfile[K],
  ) => setProfile((current) => ({ ...current, [key]: value }));
  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setSaving(true);
    setSaveError(undefined);
    const completed = { ...profile, completedAt: new Date().toISOString() };
    try {
      await saveRegistrationProfile(completed);
      setProfile(completed);
      setSaved(true);
      navigate("/storyboard", { replace: true });
    } catch (error) {
      setSaveError(
        error instanceof Error ? error.message : "Could not save registration",
      );
    } finally {
      setSaving(false);
    }
  };
  return (
    <main className="registration-page">
      <header className="registration-hero">
        <span>Welcome to Video Lab</span>
        <h1>Tell us a little about you</h1>
        <p>
          Help us tailor the creative tools and communications you see.
          Demographic and marketing questions are optional.
        </p>
      </header>
      <form className="registration-form" onSubmit={submit}>
        <section className="panel registration-identity">
          <span className="registration-step">01 · Your account</span>
          <h2>Google profile</h2>
          <div className="registration-google">
            {firebaseUser?.photoURL ? (
              <img src={firebaseUser.photoURL} alt="Google profile" />
            ) : (
              <span>
                {(firebaseUser?.displayName ?? firebaseUser?.email ?? "VL")
                  .slice(0, 2)
                  .toUpperCase()}
              </span>
            )}
            <div>
              <strong>{firebaseUser?.displayName ?? "Guest creator"}</strong>
              <small>
                {firebaseUser?.email ?? "Connect Google from your Account page"}
              </small>
            </div>
          </div>
          <p>
            Your authentication details come from Google and remain managed by
            Firebase Auth.
          </p>
        </section>

        <section className="panel registration-demographics">
          <span className="registration-step">02 · Optional demographics</span>
          <h2>About your work</h2>
          <div className="registration-fields">
            <label>
              <span>Country or region</span>
              <input
                value={profile.country}
                placeholder="e.g. United Kingdom"
                onChange={(event) => update("country", event.target.value)}
              />
            </label>
            <label>
              <span>Industry</span>
              <select
                value={profile.industry}
                onChange={(event) => update("industry", event.target.value)}
              >
                <option value="">Select one</option>
                <option>Film and television</option>
                <option>Advertising and marketing</option>
                <option>Design and creative services</option>
                <option>Technology</option>
                <option>Education</option>
                <option>Media and publishing</option>
                <option>Other</option>
              </select>
            </label>
            <label>
              <span>Your role</span>
              <input
                value={profile.role}
                placeholder="e.g. Director, founder, editor"
                onChange={(event) => update("role", event.target.value)}
              />
            </label>
            <label>
              <span>Team size</span>
              <select
                value={profile.teamSize}
                onChange={(event) => update("teamSize", event.target.value)}
              >
                <option value="">Select one</option>
                <option>Just me</option>
                <option>2–10</option>
                <option>11–50</option>
                <option>51–200</option>
                <option>201+</option>
              </select>
            </label>
            <label>
              <span>Video AI experience</span>
              <select
                value={profile.experienceLevel}
                onChange={(event) =>
                  update("experienceLevel", event.target.value)
                }
              >
                <option value="">Select one</option>
                <option>Just exploring</option>
                <option>Beginner</option>
                <option>Regular user</option>
                <option>Advanced professional</option>
              </select>
            </label>
          </div>
        </section>

        <section className="panel registration-marketing">
          <span className="registration-step">03 · Product research</span>
          <h2>What brings you here?</h2>
          <div className="registration-fields">
            <label>
              <span>How did you hear about us?</span>
              <select
                value={profile.discoverySource}
                onChange={(event) =>
                  update("discoverySource", event.target.value)
                }
              >
                <option value="">Select one</option>
                <option>Search engine</option>
                <option>Social media</option>
                <option>Friend or colleague</option>
                <option>Event or community</option>
                <option>Article or newsletter</option>
                <option>Other</option>
              </select>
            </label>
            <label>
              <span>Primary goal</span>
              <select
                value={profile.primaryGoal}
                onChange={(event) => update("primaryGoal", event.target.value)}
              >
                <option value="">Select one</option>
                <option>Create marketing videos</option>
                <option>Develop films or storyboards</option>
                <option>Prototype creative concepts</option>
                <option>Create social content</option>
                <option>Research video AI</option>
                <option>Other</option>
              </select>
            </label>
          </div>
          <div className="registration-consents">
            <label>
              <input
                type="checkbox"
                checked={profile.productUpdates}
                onChange={(event) =>
                  update("productUpdates", event.target.checked)
                }
              />
              <span>
                <b>Product news and creative tips</b>
                <small>
                  Occasional email updates. You can unsubscribe at any time.
                </small>
              </span>
            </label>
            <label>
              <input
                type="checkbox"
                checked={profile.researchInvites}
                onChange={(event) =>
                  update("researchInvites", event.target.checked)
                }
              />
              <span>
                <b>Research invitations</b>
                <small>
                  Optional invitations to interviews, surveys and early feature
                  tests.
                </small>
              </span>
            </label>
          </div>
        </section>

        <footer className="registration-actions">
          <p>
            {saveError ? (
              <span className="error">{saveError}</span>
            ) : (
              "We use these answers to improve Video Lab. Marketing consent is optional and recorded separately."
            )}
          </p>
          <div>
            <button type="button" onClick={() => navigate("/account")}>
              Skip for now
            </button>
            <button className="button" type="submit" disabled={saving}>
              {saving ? "Saving…" : saved ? "Saved" : "Complete registration"}
            </button>
          </div>
        </footer>
      </form>
    </main>
  );
}
function Account() {
  const [firebaseUser, setFirebaseUser] = useState<User | null>(null);
  const [authError, setAuthError] = useState<string>();
  const [authBusy, setAuthBusy] = useState(false);
  const [preferredName, setPreferredName] = useState(
    () => localStorage.getItem("vl_profile_name") ?? "",
  );
  const [creativeRole, setCreativeRole] = useState(
    () => localStorage.getItem("vl_profile_role") ?? "",
  );
  const [avatarChoice, setAvatarChoice] = useState(
    () => localStorage.getItem("vl_profile_avatar") ?? "google",
  );
  useEffect(() => observeAuth(setFirebaseUser), []);
  useEffect(() => {
    localStorage.setItem("vl_profile_name", preferredName);
    localStorage.setItem("vl_profile_role", creativeRole);
    localStorage.setItem("vl_profile_avatar", avatarChoice);
  }, [preferredName, creativeRole, avatarChoice]);
  const me = useQuery({ queryKey: ["me"], queryFn: () => api<Me>("/v1/me") });
  const googleProfile = firebaseUser?.providerData.find(
    (provider) => provider.providerId === "google.com",
  );
  const googleName =
    googleProfile?.displayName ?? firebaseUser?.displayName ?? "";
  const googleEmail =
    googleProfile?.email ??
    (!firebaseUser?.isAnonymous ? firebaseUser?.email : "") ??
    "";
  const googlePhoto = googleProfile?.photoURL ?? firebaseUser?.photoURL;
  const hasGoogleAccount = Boolean(googleProfile);
  const displayName =
    googleName || preferredName.trim() || googleEmail || "Video Lab creator";
  const initials =
    displayName
      .split(/\s+/)
      .slice(0, 2)
      .map((part) => part[0])
      .join("")
      .toUpperCase() || "VL";
  const avatarOptions: Array<{
    id: string;
    label: string;
    tone: string;
    avatarPosition?: string;
  }> = [
    ...(googlePhoto
      ? [{ id: "google", label: "Google photo", tone: "google" }]
      : []),
    { id: "avatar-1", label: "Avatar 1", tone: "generated", avatarPosition: "0% 0%" },
    { id: "avatar-2", label: "Avatar 2", tone: "generated", avatarPosition: "33.333% 0%" },
    { id: "avatar-3", label: "Avatar 3", tone: "generated", avatarPosition: "66.667% 0%" },
    { id: "avatar-4", label: "Avatar 4", tone: "generated", avatarPosition: "100% 0%" },
    { id: "avatar-5", label: "Avatar 5", tone: "generated", avatarPosition: "0% 100%" },
    { id: "avatar-6", label: "Avatar 6", tone: "generated", avatarPosition: "33.333% 100%" },
    { id: "avatar-7", label: "Avatar 7", tone: "generated", avatarPosition: "66.667% 100%" },
    { id: "avatar-8", label: "Avatar 8", tone: "generated", avatarPosition: "100% 100%" },
  ];
  const selectedAvatar =
    avatarOptions.find((option) => option.id === avatarChoice) ??
    avatarOptions.find((option) => option.avatarPosition);
  const selectedAvatarId = selectedAvatar?.id ?? avatarChoice;
  return (
    <main className="account-page">
      <h1 className="editorial-page-title">
        Account<span className="editorial-title-stop">.</span>
      </h1>
      <div className="account-layout">
        <div className="account-column">
          <section className="panel account-profile">
            <header className="account-profile-header">
              {avatarChoice === "google" && googlePhoto ? (
                <img
                  className="account-avatar"
                  src={googlePhoto}
                  alt="Google account profile"
                />
              ) : selectedAvatar?.avatarPosition ? (
                <span
                  className="account-avatar account-avatar-generated"
                  style={
                    {
                      "--avatar-position": selectedAvatar.avatarPosition,
                    } as React.CSSProperties
                  }
                  aria-label="Selected profile avatar"
                />
              ) : (
                <span
                  className={`account-avatar account-avatar-fallback ${avatarChoice}`}
                >
                  {initials}
                </span>
              )}
              <div>
                <span className="account-eyebrow">
                  {hasGoogleAccount
                    ? "Signed in with Google"
                    : "Video Lab profile"}
                </span>
                <h2>{displayName}</h2>
                <p>{creativeRole.trim() || "Video Lab creator"}</p>
              </div>
            </header>
            {!hasGoogleAccount && (
              <button
                disabled={authBusy}
                onClick={async () => {
                  setAuthBusy(true);
                  setAuthError(undefined);
                  try {
                    await signInWithGoogle();
                  } catch (error) {
                    setAuthError(getFriendlyAuthError(error));
                  } finally {
                    setAuthBusy(false);
                  }
                }}
              >
                {authBusy ? "Connecting…" : "Continue with Google"}
              </button>
            )}
            {authError && <p className="error">{authError}</p>}
            {hasGoogleAccount ? (
              <div className="account-contact">
                <span>Email address</span>
                <strong>{googleEmail}</strong>
                <small>
                  Your name, email and profile photo come from your Google
                  account.
                </small>
              </div>
            ) : (
              <p className="account-signin-copy">
                Connect Google to keep your profile and videos available across
                devices.
              </p>
            )}
          </section>

          <section className="panel account-security">
            <span className="account-eyebrow">Account controls</span>
            <h2>Privacy and access</h2>
            <p>
              Trial granted{" "}
              {me.data?.trialGrantedAt
                ? new Date(me.data.trialGrantedAt).toLocaleDateString()
                : "—"}
              . For a data deletion request, contact operations.
            </p>
            <button
              onClick={async () => {
                await signOutUser();
                location.href = "/";
              }}
            >
              Sign out
            </button>
          </section>
        </div>

        <div className="account-column">
          <section className="panel account-preferences">
            <span className="account-eyebrow">Optional profile</span>
            <h2>Make it yours</h2>
            <p>
              Add optional details for your Video Lab profile. These do not
              change your Google account.
            </p>
            <Link className="account-registration-link" to="/onboarding">
              Complete demographic and marketing preferences →
            </Link>
            <label>
              <span>Preferred name</span>
              <input
                value={preferredName}
                placeholder={googleName || "Your preferred name"}
                onChange={(event) => setPreferredName(event.target.value)}
              />
            </label>
            <label>
              <span>Creative role</span>
              <input
                value={creativeRole}
                placeholder="e.g. Director, editor, founder"
                onChange={(event) => setCreativeRole(event.target.value)}
              />
            </label>
            <fieldset className="account-avatar-picker">
              <legend>Select an avatar</legend>
              {avatarOptions.map((option) => {
	                const useGooglePhoto = option.id === "google" && googlePhoto;
                return (
                  <label
                    key={option.id}
                    className={selectedAvatarId === option.id ? "selected" : ""}
                  >
                    <input
                      type="radio"
                      name="account-avatar"
                      value={option.id}
                      checked={selectedAvatarId === option.id}
                      onChange={() => setAvatarChoice(option.id)}
                    />
                    {useGooglePhoto ? (
                      <img src={googlePhoto} alt="" />
                    ) : option.avatarPosition ? (
                      <span
                        className="account-avatar-option generated"
                        style={
                          {
                            "--avatar-position": option.avatarPosition,
                          } as React.CSSProperties
                        }
                      />
                    ) : (
                      <span className={`account-avatar-option ${option.tone}`}>
                        {initials}
                      </span>
                    )}
                    <small>{option.label}</small>
                  </label>
                );
              })}
            </fieldset>
          </section>
        </div>
      </div>
    </main>
  );
}
function Admin() {
  const [manualRuntimeOrigin, setManualRuntimeOrigin] = useState("");
  const r = useQuery({
    queryKey: ["runtime"],
    queryFn: () => api<RuntimeStatus>("/v1/runtime/status"),
    refetchInterval: 15_000,
  });
  const call = (p: string) =>
    api<RuntimeStatus>(p, { method: "POST" }).then(() => r.refetch());
  const discover = useMutation({
    mutationFn: () =>
      api<RuntimeStatus>("/v1/admin/runtime/discover", { method: "POST" }),
    onSuccess: () => r.refetch(),
  });
  const connectManual = useMutation({
    mutationFn: () =>
      api<RuntimeStatus>("/v1/admin/runtime/connect", {
        method: "POST",
        body: JSON.stringify({ baseUrl: manualRuntimeOrigin }),
      }),
    onSuccess: () => {
      setManualRuntimeOrigin("");
      return r.refetch();
    },
  });
  const discovery = r.data?.discovery;
  const connected =
    r.data?.status === "healthy" && discovery?.state === "connected";
  return (
    <main className="admin-page">
      <h1 className="editorial-page-title">
        Admin<span className="editorial-title-stop">.</span>
      </h1>
      <section className="panel runtime-discovery-panel">
        <header>
          <div>
            <span className="account-eyebrow">Deploy Studio handover</span>
            <h2>Automatic Lambda connection</h2>
            <p>
              Deploy Studio securely publishes the active runtime. Video Lab
              validates its renewable lease and health automatically. If the
              handover is stuck, an administrator can force a health check
              against the known Lambda origin.
            </p>
          </div>
          <span
            className={`runtime-discovery-state ${connected ? "connected" : ""}`}
          >
            <i />
            {r.isLoading
              ? "Checking"
              : connected
                ? "Connected"
                : (discovery?.state ?? r.data?.status ?? "Unavailable")}
          </span>
        </header>
        <div className="runtime-discovery-grid">
          <span>
            <small>Discovery source</small>
            <strong>
              {discovery?.source === "deploy-studio"
                ? "Deploy Studio"
                : (discovery?.source ?? "Waiting")}
            </strong>
          </span>
          <span>
            <small>Runtime health</small>
            <strong>{r.data?.status ?? "Checking"}</strong>
          </span>
          <span>
            <small>Lease expires</small>
            <strong>
              {discovery?.state === "connected" && !discovery.leaseExpiresAt
                ? "Non-expiring"
                : discovery?.leaseExpiresAt
                  ? new Date(discovery.leaseExpiresAt).toLocaleTimeString()
                  : "—"}
            </strong>
          </span>
          <span>
            <small>Queue</small>
            <strong>{r.data?.queueDepth ?? 0}</strong>
          </span>
        </div>
        <p className={connected ? "success" : "runtime-discovery-message"}>
          {discovery?.message ??
            "Waiting for Deploy Studio to publish the active runtime."}
        </p>
        <button
          type="button"
          disabled={discover.isPending}
          onClick={() => discover.mutate()}
        >
          {discover.isPending ? "Refreshing…" : "Refresh handover"}
        </button>
        {discover.error && (
          <p className="error">
            {discover.error instanceof Error
              ? discover.error.message
              : "Runtime discovery failed"}
          </p>
        )}
        <form
          className="runtime-manual-connect"
          onSubmit={(event) => {
            event.preventDefault();
            connectManual.mutate();
          }}
        >
          <label>
            <span>Known Lambda runtime origin</span>
            <input
              type="url"
              value={manualRuntimeOrigin}
              placeholder="https://approved-runtime.example"
              autoComplete="off"
              spellCheck={false}
              onChange={(event) => setManualRuntimeOrigin(event.target.value)}
            />
          </label>
          <button type="submit" disabled={connectManual.isPending}>
            {connectManual.isPending ? "Checking…" : "Check and connect"}
          </button>
        </form>
        {connectManual.error && (
          <p className="error">
            {connectManual.error instanceof Error
              ? connectManual.error.message
              : "Manual runtime connection failed"}
          </p>
        )}
        <div className="runtime-admin-controls">
          <button onClick={() => call("/v1/admin/runtime/pause")}>
            Pause submissions
          </button>
          <button onClick={() => call("/v1/admin/runtime/resume")}>
            Resume
          </button>
          <button onClick={() => call("/v1/admin/runtime/stop")}>
            Kill switch
          </button>
        </div>
        <p>Pause and kill-switch controls remain administrator-only.</p>
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
