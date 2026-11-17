export type Viewer = { isAdmin: boolean };

export function useViewer(): Viewer {
  // Provisoire : les sessions et les droits réels arrivent avec la tâche 2.3.
  return { isAdmin: true };
}
