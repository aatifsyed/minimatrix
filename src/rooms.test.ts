import {
  MANY_ROOMS_ERROR,
  NO_ROOM_ERROR,
  pickDefaultRoom,
  REQUESTED_ROOM_ERROR,
  isUsableRoom,
  type RoomCandidate,
} from "./rooms";

function room(roomId: string, membership: string): RoomCandidate {
  return {
    roomId,
    getMyMembership: () => membership,
  };
}

describe("pickDefaultRoom", () => {
  it("uses the only joined room", () => {
    const only = room("!one:example", "join");
    expect(pickDefaultRoom([only, room("!left:example", "leave")])).toEqual({ room: only });
  });

  it("uses the only invited room", () => {
    const only = room("!invite:example", "invite");
    expect(pickDefaultRoom([only])).toEqual({ room: only });
  });

  it("rejects accounts with multiple usable rooms", () => {
    expect(pickDefaultRoom([room("!one:example", "join"), room("!two:example", "invite")])).toEqual(
      {
        error: MANY_ROOMS_ERROR,
      },
    );
  });

  it("rejects accounts with no usable rooms", () => {
    expect(pickDefaultRoom([room("!left:example", "leave")])).toEqual({ error: NO_ROOM_ERROR });
  });
});

describe("isUsableRoom", () => {
  it("allows joined and invited rooms only", () => {
    expect(isUsableRoom(room("!join:example", "join"))).toBe(true);
    expect(isUsableRoom(room("!invite:example", "invite"))).toBe(true);
    expect(isUsableRoom(room("!leave:example", "leave"))).toBe(false);
  });

  it("keeps the requested-room error stable for Matrix startup", () => {
    expect(REQUESTED_ROOM_ERROR).toBe("The requested room is not available for this account.");
  });
});
