import { Bell } from 'lucide-react';
import { Popover, PopoverContent, PopoverDescription, PopoverTitle, PopoverTrigger } from '@/components/ui/popover';
import { roundButton } from './nav-items';

// Aucune notification tant que les demandes n'existent pas : ni pastille ni compteur.
export function Notifications() {
  return (
    <Popover>
      <PopoverTrigger aria-label="Notifications" className={roundButton}>
        <Bell aria-hidden className="size-[18px]" />
      </PopoverTrigger>
      <PopoverContent align="end" sideOffset={8}>
        <PopoverTitle className="font-semibold">Aucune notification</PopoverTitle>
        <PopoverDescription>Vous serez prévenu ici quand une demande est approuvée ou disponible.</PopoverDescription>
      </PopoverContent>
    </Popover>
  );
}
