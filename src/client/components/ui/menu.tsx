import { Menu as MenuPrimitive } from '@base-ui/react/menu';
import { cn } from 'cn';

function Menu({ ...props }: MenuPrimitive.Root.Props) {
  return <MenuPrimitive.Root data-slot="menu" {...props} />;
}

function MenuTrigger({ ...props }: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="menu-trigger" {...props} />;
}

// Même habillage que PopoverContent : le menu est un élément flottant.
function MenuContent({
  className,
  align = 'center',
  alignOffset = 0,
  side = 'bottom',
  sideOffset = 8,
  ...props
}: MenuPrimitive.Popup.Props & Pick<MenuPrimitive.Positioner.Props, 'align' | 'alignOffset' | 'side' | 'sideOffset'>) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        alignOffset={alignOffset}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50"
      >
        <MenuPrimitive.Popup
          data-slot="menu-content"
          className={cn(
            'z-50 flex min-w-52 origin-(--transform-origin) flex-col gap-0.5 rounded-card bg-popover p-1.5 text-sm text-popover-foreground shadow-(--shadow-card) ring-1 ring-input [backdrop-filter:var(--blur-strong)] outline-hidden duration-(--dur) data-[side=bottom]:slide-in-from-top-2 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95',
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

const itemClass =
  'flex min-h-10 cursor-default items-center gap-3 rounded-xl px-3 text-sm font-medium outline-none select-none data-highlighted:bg-(--surface-3) aria-[current=page]:bg-(--fill-selected) aria-[current=page]:text-(--text-inverse) [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*="size-"])]:size-[18px]';

/** Entrée qui ouvre une page : à rendre avec `render={<Link … />}` pour garder la navigation du routeur. */
function MenuLinkItem({ className, ...props }: MenuPrimitive.LinkItem.Props) {
  return <MenuPrimitive.LinkItem data-slot="menu-link-item" className={cn(itemClass, className)} {...props} />;
}

export { Menu, MenuContent, MenuLinkItem, MenuTrigger };
