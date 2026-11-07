// The Add sheet's code loads apart from the first screen (the web's 500 kB first-load budget), in the one chunk the other screens share, so the code they have in common is not loaded up front; tabs fetch it once they have drawn, so + opens at once.
export const loadAddForm = () => import('../tabs')
