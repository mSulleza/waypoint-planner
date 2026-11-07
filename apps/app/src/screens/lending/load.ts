// Lending loads apart from the first screen (the web's 500 kB first-load budget), in the one chunk the other screens share.
export const loadLending = () => import('../tabs')
