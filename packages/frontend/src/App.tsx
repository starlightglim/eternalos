import { useEffect } from "react";
import {
  Routes,
  Route,
  Navigate,
  useSearchParams,
  useLocation,
} from "react-router-dom";
import { Desktop } from "./components/desktop/Desktop";
import { MobileBrowser } from "./components/desktop/MobileBrowser";
import { LandingPage } from "./pages/LandingPage";
import { LoginPage } from "./pages/LoginPage";
import { SignupPage } from "./pages/SignupPage";
import { ForgotPasswordPage } from "./pages/ForgotPasswordPage";
import { ResetPasswordPage } from "./pages/ResetPasswordPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { GoogleAuthCallback } from "./pages/GoogleAuthCallback";
import { VisitorPage } from "./pages/VisitorPage";
import { NotFoundPage } from "./pages/NotFoundPage";
import { LoadingOverlay, AlertDialog, ErrorBoundary } from "./components/ui";
import { useAuthStore } from "./stores/authStore";
import { useAlertStore } from "./stores/alertStore";
import { useIsMobile } from "./hooks/useIsMobile";
import { isApiConfigured } from "./services/api";

/**
 * Global Alert Manager
 * Renders AlertDialog based on alertStore state
 */
function GlobalAlert() {
  const { alert, closeAlert } = useAlertStore();

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
  const { user, initialized } = useAuthStore();

  if (!initialized) {
    return <LoadingOverlay message="Initializing..." />;
  }

  // If API is not configured, allow access to desktop (demo mode)
  if (!isApiConfigured) {
    return <>{children}</>;
  }

  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

// Responsive wrapper - shows MobileBrowser on small screens
function ResponsiveDesktop() {
  const isMobile = useIsMobile();
  return isMobile ? <MobileBrowser /> : <Desktop />;
}

// Smart route that shows owner Desktop or visitor view based on auth
// Note: React Router v6 doesn't support mixed literal+param segments like /@:username,
// so we extract the username from window.location.pathname manually.
function UserDesktopRoute() {
  const { user, initialized } = useAuthStore();
  const isMobile = useIsMobile();
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
    user?.username?.toLowerCase() === username.toLowerCase()
  ) {
    return isMobile ? <MobileBrowser /> : <Desktop />;
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
  const { initialize, initialized } = useAuthStore();

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
              <ResponsiveDesktop />
            </ProtectedRoute>
          }
        />

        {/* Catch-all: handles /@username visitor routes + redirects unknown paths */}
        <Route path="*" element={<CatchAllRoute />} />
      </Routes>
    </ErrorBoundary>
  );
}

export default App;
