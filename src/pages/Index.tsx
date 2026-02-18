import { useAuth } from "@/hooks/useAuth";
import { Navigate, Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { UserCircle } from "lucide-react";

const Index = () => {
  const { user, loading, signOut } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-background">
        <p className="text-muted-foreground">Loading...</p>
      </div>
    );
  }

  if (!user) return <Navigate to="/auth" replace />;

  return (
    <div className="flex min-h-screen items-center justify-center bg-background">
      <div className="text-center space-y-4">
        <h1 className="text-4xl font-bold">AHMC AI Test</h1>
        <p className="text-xl text-muted-foreground">Welcome, {user.email}</p>
        <div className="flex gap-3 justify-center">
          <Button variant="outline" asChild>
            <Link to="/profile">
              <UserCircle className="mr-2 h-4 w-4" />
              Profile
            </Link>
          </Button>
          <Button variant="outline" onClick={signOut}>Sign Out</Button>
        </div>
      </div>
    </div>
  );
};

export default Index;
