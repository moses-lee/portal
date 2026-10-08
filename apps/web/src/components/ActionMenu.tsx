"use client";

import { createContext, useContext, type ComponentProps, type ReactNode } from "react";
import {
  DropdownMenuItem,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuRadioGroup,
  ContextMenuRadioItem,
  ContextMenuSeparator,
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";

/**
 * One list of menu items for both of an element's menus: the `…` button's dropdown and the
 * right-click (long-press on touch) context menu. Radix scopes each menu's items to its own root, so
 * a list written with the `Menu*` parts below renders the dropdown's primitives by default and the
 * context menu's inside `ContextActions`. Build the items once as an element and hand the same
 * element to both, so the two menus cannot drift apart.
 */
type MenuKind = "dropdown" | "context";

const MenuKindContext = createContext<MenuKind>("dropdown");

const useKind = () => useContext(MenuKindContext);

export function MenuItem(props: ComponentProps<typeof DropdownMenuItem>) {
  return useKind() === "context" ? <ContextMenuItem {...props} /> : <DropdownMenuItem {...props} />;
}

export function MenuSeparator(props: ComponentProps<typeof DropdownMenuSeparator>) {
  return useKind() === "context" ? <ContextMenuSeparator {...props} /> : <DropdownMenuSeparator {...props} />;
}

export function MenuSub(props: ComponentProps<typeof DropdownMenuSub>) {
  return useKind() === "context" ? <ContextMenuSub {...props} /> : <DropdownMenuSub {...props} />;
}

export function MenuSubTrigger(props: ComponentProps<typeof DropdownMenuSubTrigger>) {
  return useKind() === "context" ? <ContextMenuSubTrigger {...props} /> : <DropdownMenuSubTrigger {...props} />;
}

export function MenuSubContent(props: ComponentProps<typeof DropdownMenuSubContent>) {
  return useKind() === "context" ? <ContextMenuSubContent {...props} /> : <DropdownMenuSubContent {...props} />;
}

export function MenuRadioGroup(props: ComponentProps<typeof DropdownMenuRadioGroup>) {
  return useKind() === "context" ? <ContextMenuRadioGroup {...props} /> : <DropdownMenuRadioGroup {...props} />;
}

export function MenuRadioItem(props: ComponentProps<typeof DropdownMenuRadioItem>) {
  return useKind() === "context" ? <ContextMenuRadioItem {...props} /> : <DropdownMenuRadioItem {...props} />;
}

export type ContextActionsProps = {
  /** The items, the same element the `…` dropdown renders. */
  items: ReactNode;
  /** The element right-clicked (or long-pressed); it must take a ref and spread props (`asChild`). */
  children: ReactNode;
  /** Off while the element is a text field (rename) or busy, so the browser's own menu shows. */
  disabled?: boolean;
  onCloseAutoFocus?: ComponentProps<typeof ContextMenuContent>["onCloseAutoFocus"];
};

/** `children` opens `items` as a context menu at the pointer. */
export function ContextActions({ items, children, disabled, onCloseAutoFocus }: ContextActionsProps) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild disabled={disabled}>
        {children}
      </ContextMenuTrigger>
      <ContextMenuContent onCloseAutoFocus={onCloseAutoFocus}>
        <MenuKindContext.Provider value="context">{items}</MenuKindContext.Provider>
      </ContextMenuContent>
    </ContextMenu>
  );
}
