import { createFileRoute } from '@tanstack/react-router'
import * as React from 'react'
import { useRouter } from '@tanstack/react-router'
import { InvoiceFields } from '../components/InvoiceFields'
import { Spinner } from '../components/Spinner'
import { useMutation } from '../hooks/useMutation'
import { postInvoice } from '../utils/mockTodos'
import type { Invoice } from '../utils/mockTodos'

export const Route = createFileRoute('/dashboard/invoices/')({
  component: InvoicesIndexComponent,
})

function InvoicesIndexComponent() {
  const router = useRouter()

  const createInvoiceMutation = useMutation({
    fn: postInvoice,
    onSuccess: () => router.invalidate(),
  })

  return (
    <>
      <div className="p-2">
        <form
          onSubmit={(event) => {
            event.preventDefault()
            event.stopPropagation()
            const formData = new FormData(event.target as HTMLFormElement)
            createInvoiceMutation.mutate({
              title: formData.get('title') as string,
              body: formData.get('body') as string,
            })
          }}
          className="space-y-2"
        >
          <div>Create a new Invoice:</div>
          <InvoiceFields invoice={{} as Invoice} />
          <div>
            <button
              className="bg-blue-500 rounded p-2 uppercase text-white font-black disabled:opacity-50"
              disabled={createInvoiceMutation.status === 'pending'}
            >
              {createInvoiceMutation.status === 'pending' ? (
                <>
                  Creating <Spinner />
                </>
              ) : (
                'Create'
              )}
            </button>
          </div>
          {createInvoiceMutation.status === 'success' ? (
            <div className="inline-block px-2 py-1 rounded bg-green-500 text-white animate-bounce [animation-iteration-count:2.5] [animation-duration:.3s]">
              Created!
            </div>
          ) : createInvoiceMutation.status === 'error' ? (
            <div className="inline-block px-2 py-1 rounded bg-red-500 text-white animate-bounce [animation-iteration-count:2.5] [animation-duration:.3s]">
              Failed to create.
            </div>
          ) : null}
        </form>
      </div>
    </>
  )
}
