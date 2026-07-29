// Hand-picked studio and network shortcuts for the browse sidebar.
//
// TMDB has thousands of production companies and networks, and no ranked "top
// studios" endpoint I could point at, so this is a curated list instead. The
// discover router serves it verbatim at /api/discover/studios, and the ids feed
// straight back in as with_companies (movies) or with_networks (TV).
//
// The ids are TMDB's own. Editing a name here is cosmetic; editing an id
// changes which catalogue the page shows.

export type StudioOption = {
  id: number; // TMDB company or network id
  name: string; // display label, not necessarily TMDB's official name
};

// Movie studios. Passed as with_companies, so this list is movies-only.
export const STUDIOS: StudioOption[] = [
  { id: 2, name: "Disney" },
  { id: 3, name: "Pixar" },
  { id: 420, name: "Marvel Studios" },
  { id: 174, name: "Warner Bros." },
  { id: 33, name: "Universal" },
  { id: 5, name: "Columbia Pictures" },
  { id: 4, name: "Paramount Pictures" },
  { id: 1, name: "Lucasfilm" },
  { id: 25, name: "20th Century" },
  { id: 41077, name: "A24" },
  { id: 521, name: "DreamWorks Animation" },
];

// TV networks and streamers. Passed as with_networks, so this list is TV-only.
// HBO and HBO Max are separate ids because TMDB tracks them as separate
// networks.
export const NETWORKS: StudioOption[] = [
  { id: 213, name: "Netflix" },
  { id: 49, name: "HBO" },
  { id: 3186, name: "HBO Max" },
  { id: 2739, name: "Disney+" },
  { id: 2552, name: "Apple TV+" },
  { id: 1024, name: "Prime Video" },
  { id: 453, name: "Hulu" },
  { id: 67, name: "Showtime" },
  { id: 88, name: "FX" },
  { id: 4330, name: "Paramount+" },
  { id: 3353, name: "Peacock" },
];
