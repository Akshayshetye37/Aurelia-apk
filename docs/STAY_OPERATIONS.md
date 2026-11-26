# Front-desk: extending an existing stay

A stay extension changes the checkout date on the existing booking. Do not create a second reservation for the same guest and room.

## Guest requests extra nights before check-in

1. Open **Stays** and find the guest under **Arriving**.
2. Select **Change departure** beside **Check in**.
3. Choose the new checkout date and time.
4. Review the room-availability result and additional room charge.
5. Confirm the change. The reservation keeps its original arrival date and planned check-in time.
6. Complete the normal check-in when the guest arrives.

## Guest requests extra nights after check-in

1. Open **Stays** and find the guest under **In house**.
2. Select **Extend stay** beside the booking, or open the guest's folio and select **Extend stay**.
3. Choose the new checkout date and time.
4. Review the availability check and additional room charge.
5. Confirm. The existing booking is updated, the extension is recorded in its history and audit log, and the actual check-in timestamp is retained.
6. Open the folio. The new nights are included in the room total and the outstanding balance increases by the additional charge.
7. Record any advance or additional payment through the same folio payment flow. Do not overwrite the amount already paid.

## Room conflict

The app checks other arriving and in-house bookings in the same room. Checkout is exclusive: another guest may arrive on the extension's new checkout date.

If another booking overlaps the requested extra nights, the app blocks the extension. Do not force the date or create a duplicate booking. Arrange a room change or offer the guest another available room, then update the room assignment through the existing booking workflow.

## Operational controls

- The original booking ID, guest, room, arrival date and actual check-in time remain attached to the same booking.
- Each extension stores the old and new checkout date/time, number of additional nights, nightly rate, added amount and request timestamp.
- Room charges are recalculated from the existing room rate. Review the folio before collecting money.
- The extension is rolled back if the app cannot confirm a durable save.
- If the app displays a storage warning, keep it open until the save completes. Do not close or force-stop the app while it says **Saving to device database**.
