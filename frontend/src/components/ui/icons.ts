// Local outline icons (24×24, stroked with currentColor). No icon fonts or remote assets.
// Local console icons, including the three theme states.
export const iconPaths = {
  resolve: "M6 20V5h6a5 5 0 0 1 0 10H6m6 0 6 5",
  search: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13Zm5-1 5 5",
  settings: "M4 7h7m4 0h5M4 17h3m4 0h9M11 4v6M7 14v6",
  folder: "M3 7V5h6l2 2h10v13H3Z",
  archive: "M3 3h18v5H3Zm2 5v13h14V8m-10 4h6",
  users:
    "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m18 0v-2a4 4 0 0 0-3-3.87M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm7-7.87a4 4 0 0 1 0 7.75",
  lock: "M7 10V7a5 5 0 0 1 10 0v3M5 10h14v11H5Zm7 4v3",
  logout: "M9 4H4v16h5m5-13 5 5-5 5m-7-5h12",
  chat: "M5 4h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H9l-6 4V6a2 2 0 0 1 2-2Zm2 5h10M7 13h6",
  back: "m14 6-6 6 6 6",
  info: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20Zm0-11v6m0-10h.01",
  close: "m6 6 12 12M6 18 18 6",
  attach: "m8 13 6-6a3 3 0 0 1 4 4l-8 8a5 5 0 0 1-7-7l9-9a2 2 0 0 1 3 3l-9 9",
  image: "M3 3h18v18H3Zm0 13 5-5 4 4 3-3 6 6M15 6a2 2 0 1 0 0 4 2 2 0 0 0 0-4Z",
  video: "M3 5h12v14H3Zm12 5 6-4v12l-6-4",
  document: "M5 3h9l5 5v13H5Zm9 0v5h5M8 12h8m-8 4h6",
  audio: "M9 17V5l10-2v12M9 17a3 3 0 1 1-3-3h3m10 1a3 3 0 1 1-3-3h3",
  file: "M5 3h9l5 5v13H5Zm9 0v5h5",
  send: "M12 20V4m-6 6 6-6 6 6",
  plus: "M12 5v14M5 12h14",
  minus: "M5 12h14",
  check: "m5 12 4 4L19 6",
  star: "m12 3 2.78 5.63L21 9.53l-4.5 4.39 1.06 6.2L12 17.2l-5.56 2.92 1.06-6.2L3 9.53l6.22-.9Z",
  // Opens a menu of choices (project, folder of a dialogue).
  chevron: "m7 10 5 5 5-5",
  // Theme states: system (a display), light (a sun), dark (a crescent).
  monitor: "M4 5h16v11H4Zm5 15h6m-3-4v4",
  sun: "M12 8.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7ZM12 3v2m0 14v2M3 12h2m14 0h2M5.64 5.64l1.42 1.42m9.88 9.88 1.42 1.42m-12.72 0 1.42-1.42m9.88-9.88 1.42-1.42",
  moon: "M19.5 14.5A7.5 7.5 0 1 1 9.5 4.5a6 6 0 0 0 10 10Z",
} as const;

export type IconName = keyof typeof iconPaths;
