export interface RoomCandidate {
  roomId: string;
  getMyMembership(): string;
}

export interface RoomPick<T> {
  room?: T;
  error?: string;
}

export const NO_ROOM_ERROR = "No room is available for this account yet.";
export const MANY_ROOMS_ERROR =
  "This account has more than one room. Add a room ID to the magic link.";
export const REQUESTED_ROOM_ERROR = "The requested room is not available for this account.";

export function isUsableRoom(room: RoomCandidate): boolean {
  const membership = room.getMyMembership();
  return membership === "join" || membership === "invite";
}

export function pickDefaultRoom<T extends RoomCandidate>(rooms: readonly T[]): RoomPick<T> {
  const usable = rooms.filter(isUsableRoom);
  if (usable.length === 1) return { room: usable[0] };
  if (usable.length > 1) return { error: MANY_ROOMS_ERROR };
  return { error: NO_ROOM_ERROR };
}
