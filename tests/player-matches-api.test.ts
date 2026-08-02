 import { describe, it, expect } from "vitest";
 import { GET } from "../app/api/pubg/player/matches/route";
 import { NextRequest } from "next/server";
 
 describe("GET /api/pubg/player/matches route validation", () => {
   it("requires nickname and platform parameters", async () => {
     const req = new NextRequest("http://localhost/api/pubg/player/matches");
     const res = await GET(req);
     expect(res.status).toBe(400);
     const body = await res.json();
     expect(body.error).toContain("닉네임");
   });
 });
