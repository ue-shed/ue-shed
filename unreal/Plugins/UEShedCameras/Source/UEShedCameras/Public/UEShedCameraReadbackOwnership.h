#pragma once

#include "CoreMinimal.h"

#include <atomic>

namespace UEShedCameraReadback
{
/**
 * Who may touch one readback slot's pixels: the game thread or one queued render-thread poll.
 *
 * Available -> Copying{generation} -> Ready{generation} -> Available. The game thread starts each
 * capture with a new generation, queues at most one poll for it at a time and consumes Ready. A poll
 * carries the generation it was queued for and may copy only while the slot is still Copying that
 * generation, so a poll queued for an earlier capture can never write into a recycled slot (the
 * generation is the fence: a bare state check would accept a new capture's Copying as its own).
 * A slot is not available again until its queued poll has finished, so a poll never runs while the
 * game thread rewrites the slot for the next capture.
 */
class FSlotOwnership
{
public:
	enum class EState : uint8
	{
		Available,
		Copying,
		Ready
	};

	// Game thread.

	/** True when a new capture may reuse the slot: nothing is copying and no poll is queued. */
	bool IsAvailable() const
	{
		return StateOf(Word.load(std::memory_order_acquire)) == EState::Available
			&& QueuedPoll.load(std::memory_order_acquire) == 0;
	}

	/** Claims an available slot for a new capture. Write the capture's metadata before this. */
	uint64 BeginCapture()
	{
		check(IsAvailable());
		const uint64 Generation = ++LastGeneration;
		Word.store(Pack(Generation, EState::Copying), std::memory_order_release);
		return Generation;
	}

	/** Returns a capture that was never submitted for copying. */
	void AbandonCapture(uint64 Generation)
	{
		uint64 Expected = Pack(Generation, EState::Copying);
		Word.compare_exchange_strong(Expected, Pack(Generation, EState::Available),
			std::memory_order_acq_rel);
	}

	/** Records one poll for the current capture. False while one is already queued. */
	bool TryQueuePoll(uint64& OutGeneration)
	{
		const uint64 Current = Word.load(std::memory_order_acquire);
		if (StateOf(Current) != EState::Copying) return false;
		uint64 None = 0;
		const uint64 Generation = GenerationOf(Current);
		if (!QueuedPoll.compare_exchange_strong(None, Generation, std::memory_order_acq_rel))
			return false;
		OutGeneration = Generation;
		return true;
	}

	/** True when a finished copy waits to be consumed. Pixels written by the poll are visible. */
	bool IsReady() const
	{
		return StateOf(Word.load(std::memory_order_acquire)) == EState::Ready;
	}

	/** Releases a consumed Ready slot. */
	void Consume()
	{
		const uint64 Current = Word.load(std::memory_order_acquire);
		check(StateOf(Current) == EState::Ready);
		Word.store(Pack(GenerationOf(Current), EState::Available), std::memory_order_release);
	}

	// Render thread, from the poll queued for Generation.

	/** True while the slot still belongs to this poll's capture, so the poll may copy into it. */
	bool OwnsCapture(uint64 Generation) const
	{
		return Word.load(std::memory_order_acquire) == Pack(Generation, EState::Copying);
	}

	/** Ends this poll. A finished copy publishes Ready only for the capture it was queued for. */
	void FinishPoll(uint64 Generation, bool bCopied)
	{
		if (bCopied)
		{
			uint64 Expected = Pack(Generation, EState::Copying);
			Word.compare_exchange_strong(Expected, Pack(Generation, EState::Ready),
				std::memory_order_acq_rel);
		}
		// Last: the game thread may reuse the slot only after this poll stops touching it.
		uint64 Mine = Generation;
		QueuedPoll.compare_exchange_strong(Mine, 0, std::memory_order_acq_rel);
	}

	EState State() const { return StateOf(Word.load(std::memory_order_acquire)); }

private:
	static uint64 Pack(uint64 Generation, EState State)
	{
		return (Generation << 2) | static_cast<uint64>(State);
	}
	static EState StateOf(uint64 Value) { return static_cast<EState>(Value & 3); }
	static uint64 GenerationOf(uint64 Value) { return Value >> 2; }

	std::atomic<uint64> Word{ 0 };
	// Generation of the one queued poll, or 0. Generations start at 1.
	std::atomic<uint64> QueuedPoll{ 0 };
	uint64 LastGeneration = 0;
};
}
