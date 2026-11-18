import type { Page, Route } from '@playwright/test';
import {
  ISSUES_PAGE_SIZE,
  type IssueAuthor,
  type IssueCommentInput,
  type IssueCounts,
  type IssueCreateInput,
  type IssueDetail,
  type IssuePage,
  issueListQuerySchema,
} from '../src/shared/issues.ts';
import { fixtures } from './catalogue-mocks.ts';

// Faux `/api/issues*` : signalements en mémoire, typés par le contrat partagé. Un seul membre agit (`actor`), qui voit
// tous les signalements du faux serveur : un test de membre n'y met que les siens.

export const author = (name: string): IssueAuthor => ({ id: `id-${name}`, name, avatarUrl: null });
/** Le propriétaire du faux serveur (`viewerAs('owner')`), qui répond et résout dans les exemples. */
export const quentin: IssueAuthor = { id: 'id-owner', name: 'Quentin', avatarUrl: null };

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();

let nextId = 1;
/** Signalement de test sur un titre des fixtures (`'movie'` : Le Robot sauvage, `'tv'` : Shōgun). */
export function makeIssue(
  target: 'movie' | 'tv',
  overrides: Partial<IssueDetail> & Pick<IssueDetail, 'author' | 'message'>,
): IssueDetail {
  const media = fixtures[target];
  const createdAt = overrides.createdAt ?? ago(90);
  return {
    id: nextId++,
    type: 'subtitles',
    status: 'open',
    media: { type: media.type, tmdbId: media.tmdbId },
    seasonNumber: null,
    episodeNumber: null,
    resolvedBy: null,
    createdAt,
    updatedAt: createdAt,
    resolvedAt: null,
    title: media.title,
    posterPath: media.posterPath,
    comments: [],
    ...overrides,
  };
}

export const comment = (issue: IssueDetail, who: IssueAuthor, message: string, minutes: number) => ({
  id: issue.id * 100 + issue.comments.length + 1,
  issueId: issue.id,
  author: who,
  message,
  createdAt: ago(minutes),
});

/** Trois signalements : deux ouverts (dont un sur une série, avec un échange) et un résolu. */
export function sampleIssues(): IssueDetail[] {
  const [marion, theo] = [author('Marion'), author('Théo')];
  const audio = makeIssue('movie', {
    id: 1,
    type: 'audio',
    author: marion,
    message: 'Le son est très faible dans la version française, les dialogues sont presque inaudibles.',
    createdAt: ago(12),
  });
  const subtitles = makeIssue('tv', {
    id: 2,
    type: 'subtitles',
    seasonNumber: 1,
    episodeNumber: 4,
    author: theo,
    message: 'Les sous-titres français sont décalés de plusieurs secondes.',
    createdAt: ago(26 * 60),
  });
  subtitles.comments = [
    comment(subtitles, quentin, 'Je regarde, je relance une recherche de sous-titres.', 20 * 60),
    comment(subtitles, theo, 'Merci !', 19 * 60),
  ];
  const resolved = makeIssue('movie', {
    id: 3,
    type: 'video',
    status: 'resolved',
    author: theo,
    message: 'L’image saute à partir de la 40e minute.',
    resolvedBy: quentin,
    resolvedAt: ago(3 * 24 * 60),
    createdAt: ago(5 * 24 * 60),
  });
  return [audio, subtitles, resolved];
}

export class IssuesMock {
  issues: IssueDetail[];
  /** Corps reçus. */
  posts: IssueCreateInput[] = [];
  comments: { id: number; body: IssueCommentInput }[] = [];
  resolves: number[] = [];
  reopens: number[] = [];
  /** Réponse d'erreur à servir aux créations. */
  createError: { status: number; error: string } | null = null;

  readonly page: Page;
  readonly actor: IssueAuthor;

  constructor(page: Page, actor: IssueAuthor, issues: IssueDetail[]) {
    this.page = page;
    this.actor = actor;
    this.issues = issues;
  }

  async install() {
    await this.page.route(
      (url) => url.pathname.startsWith('/api/issues'),
      (route) => this.handle(route),
    );
    return this;
  }

  private touch(issue: IssueDetail) {
    issue.updatedAt = new Date().toISOString();
    return issue;
  }

  private async handle(route: Route) {
    const url = new URL(route.request().url());
    const method = route.request().method();
    const path = url.pathname;
    const json = (status: number, body: unknown) => route.fulfill({ status, json: body });
    if (method === 'GET' && path === '/api/issues') {
      const query = issueListQuerySchema.safeParse(Object.fromEntries(url.searchParams));
      if (!query.success) return json(400, { error: 'Requête invalide' });
      const { status, page } = query.data;
      const matching = this.issues.filter((i) => !status || i.status === status);
      const start = (page - 1) * ISSUES_PAGE_SIZE;
      return json(200, {
        page,
        totalPages: Math.ceil(matching.length / ISSUES_PAGE_SIZE),
        results: matching.slice(start, start + ISSUES_PAGE_SIZE).map(({ comments: _, ...view }) => view),
        totals: {
          open: this.issues.filter((i) => i.status === 'open').length,
          resolved: this.issues.filter((i) => i.status === 'resolved').length,
        },
      } satisfies IssuePage);
    }
    if (method === 'GET' && path === '/api/issues/counts')
      return json(200, { open: this.issues.filter((i) => i.status === 'open').length } satisfies IssueCounts);
    if (method === 'POST' && path === '/api/issues') {
      const input = route.request().postDataJSON() as IssueCreateInput;
      this.posts.push(input);
      // Le temps de voir le bouton désactivé pendant l'envoi.
      await new Promise((resolve) => setTimeout(resolve, 300));
      if (this.createError) return json(this.createError.status, { error: this.createError.error });
      const target = input.mediaType === 'tv' ? 'tv' : 'movie';
      const created = makeIssue(target, {
        author: this.actor,
        type: input.type,
        message: input.message,
        seasonNumber: input.seasonNumber ?? null,
        episodeNumber: input.episodeNumber ?? null,
      });
      this.issues.unshift(created);
      return json(201, created);
    }
    const id = Number(path.match(/^\/api\/issues\/(\d+)/)?.[1]);
    const found = this.issues.find((i) => i.id === id);
    if (!found) return json(404, { error: 'Signalement introuvable' });
    if (method === 'GET') return json(200, found);
    if (method === 'POST' && path.endsWith('/comments')) {
      const body = route.request().postDataJSON() as IssueCommentInput;
      this.comments.push({ id, body });
      found.comments.push(comment(found, this.actor, body.message, 0));
      return json(200, this.touch(found));
    }
    if (method === 'POST' && path.endsWith('/resolve')) {
      this.resolves.push(id);
      if (found.status === 'resolved') return json(409, { error: 'Ce signalement est déjà résolu' });
      Object.assign(found, { status: 'resolved', resolvedBy: this.actor, resolvedAt: new Date().toISOString() });
      return json(200, this.touch(found));
    }
    if (method === 'POST' && path.endsWith('/reopen')) {
      this.reopens.push(id);
      Object.assign(found, { status: 'open', resolvedBy: null, resolvedAt: null });
      return json(200, this.touch(found));
    }
    return json(404, { error: 'Introuvable' });
  }
}

export const mockIssues = (page: Page, actor: IssueAuthor, issues: IssueDetail[]) =>
  new IssuesMock(page, actor, issues).install();
