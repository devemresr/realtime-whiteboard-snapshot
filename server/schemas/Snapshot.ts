import mongoose, { Schema } from 'mongoose';

interface Stroke {
	x: number;
	y: number;
	timestamp: number;
}

// Base interface for data operations (insert, update)
export interface SnapshotData {
	roomId: string;
	snapshotId: string;
	roomData: RoomData[];
}

type RoomData = {
	strokes: Stroke[];
	strokeId: string;
	packageSequenceNumber: number;
	isLastPackage?: boolean;
	strokeSequenceNumber: number;
	packageId: string;
	redisMessageId: string;
	isPersisted: boolean;
	originalSocketId: string;
};

const StrokeSchema = new Schema<Stroke>(
	{
		// todo change it later
		x: { type: Number, required: false },
		y: { type: Number, required: false },
		timestamp: { type: Number, required: false },
	},
	{ _id: false } // no separate id for subdocs
);

const SnapshotSchema = new Schema(
	{
		snapshotId: { type: String, required: true, unique: true },
		roomId: { type: String, required: true },
		compressedSnapshotData: { type: String, required: true },
		snapshotTotalEventCount: { type: Number, required: true },
		createdAt: { type: Date, default: Date.now, expires: 3600 }, // TTL since its for onboards and nothing else
	},
	{ timestamps: true }
);

export default mongoose.model<SnapshotData>('SnapshotSchema', SnapshotSchema);
