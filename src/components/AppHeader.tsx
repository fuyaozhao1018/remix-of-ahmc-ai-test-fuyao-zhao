import { useAuth } from "@/hooks/useAuth";
import { Button } from "@/components/ui/button";
import { UserCircle, LogOut } from "lucide-react";
import { Link } from "react-router-dom";

const AppHeader = () => {
  const { user, signOut } = useAuth();

  if (!user) return null;

  return (
    <header className="sticky top-0 z-50 w-full border-b border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/60">
      <div className="mx-auto flex h-14 max-w-5xl items-center justify-between px-4">
        <Link to="/clinical-input" className="text-lg font-bold text-foreground">
          Clinical Optimizer
        </Link>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" asChild>
            <Link to="/profile">
              <UserCircle className="mr-1.5 h-4 w-4" />
              Profile
            </Link>
          </Button>
          <Button variant="ghost" size="sm" onClick={signOut}>
            <LogOut className="mr-1.5 h-4 w-4" />
            Sign Out
          </Button>
        </div>
      </div>
    </header>
  );
};

export default AppHeader;
