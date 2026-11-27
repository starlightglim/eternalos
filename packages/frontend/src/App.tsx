import { lazy, Suspense, useEffect, useState } from "react";
import {
  Routes,
  Route,
  Navigate,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { LoadingOverlay, AlertDialog, ErrorBoundary } from "./components/ui";
import { useAuthStore } from "./stores/authStore";
import { useAlertStore } from "./stores/alertStore";
import { useDesktopSync } from "./hooks/useDesktopSync";
import { isApiConfigured } from "./services/api";
import { decideMobileLayout } from "./utils/layoutMode";

const Desktop = lazy(() => import("./components/desktop/Desktop").then(({ Desktop: component }) => ({ default: component })));
const MobileBrowser = lazy(() => import("./components/desktop/MobileBrowser").then(({ MobileBrowser: component }) => ({ default: component })));
const LandingPage = lazy(() => import("./pages/LandingPage").then(({ LandingPage: component }) => ({ default: component })));
const LoginPage = lazy(() => import("./pages/LoginPage").then(({ LoginPage: component }) => ({ default: component })));
const SignupPage = lazy(() => import("./pages/SignupPage").then(({ SignupPage: component }) => ({ default: component })));
const ForgotPasswordPage = lazy(() => import("./pages/ForgotPasswordPage").then(({ ForgotPasswordPage: component }) => ({ default: component })));
const ResetPasswordPage = lazy(() => import("./pages/ResetPasswordPage").then(({ ResetPasswordPage: component }) => ({ default: component })));
const VerifyEmailPage = lazy(() => import("./pages/VerifyEmailPage").then(({ VerifyEmailPage: component }) => ({ default: component })));
const GoogleAuthCallback = lazy(() => import("./pages/GoogleAuthCallback").then(({ GoogleAuthCallback: component }) => ({ default: component })));
const VisitorPage = lazy(() => import("./pages/VisitorPage").then(({ VisitorPage: component }) => ({ default: component })));
const NotFoundPage = lazy(() => import("./pages/NotFoundPage").then(({ NotFoundPage: component }) => ({ default: component })));

/**
 * Global Alert Manager
 * Renders AlertDialog based on alertStore state
 */
function GlobalAlert() {
  const alert = useAlertStore((state) => state.alert);
  const closeAlert = useAlertStore((state) => state.closeAlert);

  if (!alert) return null;

  // Build button handlers based on alert type
  const handleClose = () => {
    closeAlert();
    alert.onCancel?.();
  };

  const handleConfirm = () => {
    closeAlert();
    alert.onConfirm?.();
  };

  // Generate buttons based on alert type
  const buttons =
    alert.type === "confirm"
      ? [
          { label: "Cancel", onClick: handleClose },
          { label: "OK", onClick: handleConfirm, primary: true },
        ]
      : [{ label: "OK", onClick: handleClose, primary: true }];

  return (
    <AlertDialog
      type={alert.type}
      title={alert.title}
      message={alert.message}
      buttons={buttons}
      onClose={handleClose}
    />
  );
}

// Protected route wrapper for authenticated pages
function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const hasUser = useAuthStore((state) => state.user !== null);
  const initialized = useAuthStore((state) => state.initialized);

  if (!initialized) {
    return <LoadingOverlay message="Initializing..." />;
  }

  // If API is not configured, allow access to desktop (demo mode)
  if (!isApiConfigured) {
    return <>{children}</>;
  }

  if (!hasUser) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function readLayout(previous?: boolean): boolean {
  if (typeof window === "undefined") return false;
  const coarsePointer =
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches;
  return decideMobileLayout({
    width: window.innerWidth,
    height: window.innerHeight,
    coarsePointer,
    previous,
  });
}

/**
 * Mobile vs desktop layout with hysteresis + a short debounce: swapping the
 * two trees destroys every open viewer, so a small resize near the
 * breakpoint (or a phone rotating) must not flip it. See utils/layoutMode.
 */
function useMobileLayout(): boolean {
  const [isMobile, setIsMobile] = useState(() => readLayout());

  useEffect(() => {
    let timer: number | undefined;
    const onResize = () => {
      window.clearTimeout(timer);
      timer = window.setTimeout(() => {
        setIsMobile((previous) => readLayout(previous));
      }, 150);
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  return isMobile;
}

/**
 * The signed-in owner's own desktop. Syncs with the server once here (above
 * the layout switch) so both the desktop and the mobile layout get server
 * data, and a layout change doesn't refetch.
 */
function OwnerDesktop() {
  useDesktopSync();
  const isMobile = useMobileLayout();
  return isMobile ? <MobileBrowser /> : <Desktop />;
}

// Smart route that shows owner Desktop or visitor view based on auth
// Note: React Router v6 doesn't support mixed literal+param segments like /@:username,
// so we extract the username from window.location.pathname manually.
function UserDesktopRoute() {
  const ownUsername = useAuthStore((state) => state.user?.username);
  const initialized = useAuthStore((state) => state.initialized);
  const [searchParams] = useSearchParams();
  const username = window.location.pathname.slice(2).split("?")[0]; // Remove "/@" and query params

  if (!initialized && isApiConfigured) {
    return <LoadingOverlay message="Loading..." />;
  }

  // Force visitor view when ?visitor=true is set (used by "Preview as Visitor")
  const forceVisitor = searchParams.get("visitor") === "true";

  // If logged in as this user and not forcing visitor mode, show owner's Desktop
  if (
    !forceVisitor &&
    ownUsername?.toLowerCase() === username.toLowerCase()
  ) {
    return <OwnerDesktop />;
  }

  // Otherwise show visitor view (has its own mobile handling)
  return <VisitorPage />;
}

/**
 * Catch-all route handler.
 * React Router v6 can't match /@:username (params must be full segments),
 * so we handle /@username URLs here by checking the pathname manually.
 */
function CatchAllRoute() {
  const location = useLocation();

  // Handle /@username paths
  if (location.pathname.startsWith("/@") && location.pathname.length > 2) {
    return <UserDesktopRoute />;
  }

  // Everything else → show 404 page
  return <NotFoundPage />;
}

function App() {
  const initialize = useAuthStore((state) => state.initialize);
  const initialized = useAuthStore((state) => state.initialized);

  useEffect(() => {
    const unsubscribe = initialize();
    return () => unsubscribe();
  }, [initialize]);

  // Show loading screen while auth initializes
  if (!initialized && isApiConfigured) {
    return <LoadingOverlay message="Starting EternalOS..." />;
  }

  return (
    <ErrorBoundary>
      {/* Global Alert Dialog */}
      <GlobalAlert />

      <Suspense fallback={<LoadingOverlay message="Loading EternalOS…" />}>
        <Routes>
          {/* Public routes */}
          <Route path="/" element={<LandingPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/verify-email" element={<VerifyEmailPage />} />
          <Route path="/auth/callback" element={<GoogleAuthCallback />} />

          {/* Protected routes */}
          <Route
            path="/desktop"
            element={
              <ProtectedRoute>
                <OwnerDesktop />
              </ProtectedRoute>
            }
          />

          {/* Catch-all: handles /@username visitor routes + redirects unknown paths */}
          <Route path="*" element={<CatchAllRoute />} />
        </Routes>
      </Suspense>
    </ErrorBoundary>
  );
}

export default App;
