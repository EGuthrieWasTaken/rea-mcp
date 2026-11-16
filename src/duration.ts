/** A length of time as people say it: whole minutes where it is a whole number of them ("10 minutes"), otherwise seconds ("90 seconds"). */
export function describeDuration(seconds: number): string {
  if (seconds > 0 && seconds % 60 === 0) {
    const minutes = seconds / 60;
    return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  }
  return seconds === 1 ? "1 second" : `${seconds} seconds`;
}
