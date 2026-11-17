import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { focusRing } from './nav-items';

export function AppName({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn('rounded-md font-semibold tracking-tight', focusRing, className)}>
      Request
    </Link>
  );
}
