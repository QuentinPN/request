import { Link } from '@tanstack/react-router';
import { cn } from 'cn';
import { Logo } from '../logo';
import { focusRing } from './nav-items';

export function AppName({ className }: { className?: string }) {
  return (
    <Link to="/" className={cn('inline-flex rounded-md', focusRing, className)}>
      <Logo />
    </Link>
  );
}
