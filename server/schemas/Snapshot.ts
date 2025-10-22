import mongoose, { Schema } from 'mongoose';

interface Stroke {
	x: number;
	y: number;
	timestamp: number;
}

// Base interface for data operations (insert, update)
export interface SnapshotData {
	roomId: string;
	snapShotId: string;
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
		x: { type: Number, required: true },
		y: { type: Number, required: true },
		timestamp: { type: Number, required: true },
	},
	{ _id: false } // no separate id for subdocs
);

const SnapshotSchema = new Schema(
	{
		snapshotId: { type: String, required: true, unique: true },
		roomId: { type: String, required: true },
		roomsData: [
			{
				strokes: { type: [StrokeSchema], required: true },
				strokeId: { type: String, required: true },
				roomId: { type: String, required: true },
				packageSequenceNumber: { type: Number, required: true },
				originalSocketId: { type: String, required: false },
				isLastPackage: { type: Boolean, required: false },
				strokeSequenceNumber: { type: Number, required: true },
				packageId: { type: String, required: true },
				redisMessageId: { type: String, required: false },
				isPersisted: { type: Boolean, required: true },
			},
		],
		createdAt: { type: Date, default: Date.now, expires: 3600 }, // TTL since its for onboards and nothing else
	},
	{ timestamps: true }
);

export default mongoose.model<SnapshotData>('SnapshotSchema', SnapshotSchema);
